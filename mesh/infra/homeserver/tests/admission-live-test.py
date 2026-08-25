#!/usr/bin/env python3
"""Live one-motion admission acceptance against a disposable Synapse stack."""

from __future__ import annotations

import json
import os
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


SYNAPSE = os.environ.get("MESH_TEST_SYNAPSE_URL", "http://127.0.0.1:8008").rstrip("/")
ADMISSION = os.environ.get("MESH_TEST_ADMISSION_URL", "http://127.0.0.1:8090").rstrip("/")
CREATOR = os.environ.get("MESH_TEST_CREATOR", "@alice:hs1.mesh.test")
CREATOR_PASSWORD = os.environ.get("MESH_TEST_CREATOR_PASSWORD", "mesh-alice")
CREATOR_ACCESS_TOKEN = os.environ.get("MESH_TEST_CREATOR_ACCESS_TOKEN", "")


def request(
    method: str,
    base: str,
    path: str,
    body: dict[str, Any] | None = None,
    token: str | None = None,
) -> tuple[int, dict[str, Any]]:
    headers = {"Accept": "application/json"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body, separators=(",", ":")).encode("utf-8")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    operation = urllib.request.Request(
        f"{base}{path}",
        data=data,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(operation, timeout=20) as response:
            status = response.status
            payload = response.read(128 * 1024 + 1)
    except urllib.error.HTTPError as error:
        status = error.code
        payload = error.read(128 * 1024 + 1)
    if len(payload) > 128 * 1024:
        raise RuntimeError("live acceptance endpoint returned an oversized response")
    try:
        decoded = json.loads(payload or b"{}")
    except json.JSONDecodeError as error:
        raise RuntimeError(f"live acceptance endpoint returned invalid JSON ({status})") from error
    if not isinstance(decoded, dict):
        raise RuntimeError(f"live acceptance endpoint returned a non-object ({status})")
    return status, decoded


def require_success(
    operation: str,
    result: tuple[int, dict[str, Any]],
) -> dict[str, Any]:
    status, payload = result
    if not 200 <= status < 300:
        code = payload.get("errcode") or payload.get("code") or "unknown_error"
        raise RuntimeError(f"{operation} failed with HTTP {status} ({code})")
    return payload


def login(user: str, password: str) -> str:
    payload = require_success(
        "creator login",
        request(
            "POST",
            SYNAPSE,
            "/_matrix/client/v3/login",
            {
                "type": "m.login.password",
                "identifier": {"type": "m.id.user", "user": user},
                "password": password,
                "initial_device_display_name": "Mesh admission live acceptance",
            },
        ),
    )
    token = str(payload.get("access_token", ""))
    if not token:
        raise RuntimeError("creator login returned no access token")
    return token


def register_with_token(username: str, password: str, registration_token: str) -> str:
    base_body = {
        "username": username,
        "password": password,
        "inhibit_login": False,
        "initial_device_display_name": "Mesh admission live acceptance",
    }
    status, challenge = request(
        "POST",
        SYNAPSE,
        "/_matrix/client/v3/register",
        base_body,
    )
    if status != 401 or not challenge.get("session"):
        raise RuntimeError(f"registration did not return a UIAA challenge (HTTP {status})")
    result: dict[str, Any] | None = None
    for _attempt in range(4):
        flows = challenge.get("flows")
        completed_stages = set(challenge.get("completed", []))
        if not isinstance(flows, list):
            raise RuntimeError("registration returned no supported UIAA flow")
        remaining: list[str] | None = None
        for flow in flows:
            stages = flow.get("stages", []) if isinstance(flow, dict) else []
            candidate = [stage for stage in stages if stage not in completed_stages]
            if candidate and all(
                stage in {"m.login.registration_token", "m.login.dummy"}
                for stage in candidate
            ):
                remaining = candidate
                break
        if not remaining:
            raise RuntimeError("registration returned no supported incomplete UIAA stage")

        stage = (
            "m.login.registration_token"
            if "m.login.registration_token" in remaining
            else "m.login.dummy"
        )
        auth: dict[str, Any] = {
            "type": stage,
            "session": challenge["session"],
        }
        if stage == "m.login.registration_token":
            auth["token"] = registration_token
        status, payload = request(
            "POST",
            SYNAPSE,
            "/_matrix/client/v3/register",
            {**base_body, "auth": auth},
        )
        if 200 <= status < 300:
            result = payload
            break
        if status != 401 or not payload.get("session"):
            code = payload.get("errcode") or "unknown_error"
            raise RuntimeError(
                f"bounded registration failed with HTTP {status} ({code})"
            )
        challenge = payload

    if result is None:
        raise RuntimeError("bounded registration did not complete its supported UIAA flow")
    token = str(result.get("access_token", ""))
    if not token:
        raise RuntimeError("bounded registration returned no access token")
    return token


def main() -> None:
    creator_token = CREATOR_ACCESS_TOKEN or login(CREATOR, CREATOR_PASSWORD)
    suffix = f"{int(time.time())}{secrets.token_hex(3)}"
    room = require_success(
        "private community creation",
        request(
            "POST",
            SYNAPSE,
            "/_matrix/client/v3/createRoom",
            {
                "name": f"Admission acceptance {suffix}",
                "preset": "private_chat",
                "visibility": "private",
                "creation_content": {"type": "m.space"},
            },
            creator_token,
        ),
    )
    room_id = str(room.get("room_id", ""))
    if not room_id.startswith("!"):
        raise RuntimeError("community creation returned no room ID")
    channel = require_success(
        "private channel creation",
        request(
            "POST",
            SYNAPSE,
            "/_matrix/client/v3/createRoom",
            {
                "name": f"general-{suffix}",
                "preset": "private_chat",
                "visibility": "private",
            },
            creator_token,
        ),
    )
    channel_id = str(channel.get("room_id", ""))
    if not channel_id.startswith("!"):
        raise RuntimeError("channel creation returned no room ID")
    encoded_space = urllib.parse.quote(room_id, safe="")
    encoded_channel = urllib.parse.quote(channel_id, safe="")
    require_success(
        "space child publication",
        request(
            "PUT",
            SYNAPSE,
            (
                f"/_matrix/client/v3/rooms/{encoded_space}/state/"
                f"m.space.child/{encoded_channel}"
            ),
            {"via": ["hs1.mesh.test"], "suggested": True},
            creator_token,
        ),
    )

    created = require_success(
        "admission creation",
        request(
            "POST",
            ADMISSION,
            "/v1/invitations",
            {"room_id": room_id},
            creator_token,
        ),
    )
    invite_url = str(created.get("invite_url", ""))
    admission_code = invite_url.rsplit("/", 1)[-1]
    if len(admission_code) < 32:
        raise RuntimeError("admission creation returned no bounded invitation")

    resolved = require_success(
        "admission resolution",
        request(
            "GET",
            ADMISSION,
            f"/v1/invitations/{admission_code}",
        ),
    )
    if resolved.get("room_id") != room_id:
        raise RuntimeError("admission resolved to the wrong community")
    registration_token = str(resolved.get("registration_token", ""))
    if not registration_token:
        raise RuntimeError("admission resolution returned no registration token")

    username = f"invite{suffix}"[:32]
    claimant_password = f"Mesh-live-{secrets.token_urlsafe(18)}"
    claimant_token = register_with_token(
        username,
        claimant_password,
        registration_token,
    )
    claimant_user = f"@{username}:hs1.mesh.test"
    claimed = require_success(
        "community admission claim",
        request(
            "POST",
            ADMISSION,
            f"/v1/invitations/{admission_code}/claim",
            {"user_id": claimant_user},
        ),
    )
    if claimed.get("room_id") != room_id:
        raise RuntimeError("claim returned the wrong community")

    for target, label in (
        (room_id, "community"),
        (channel_id, "private channel"),
    ):
        encoded_target = urllib.parse.quote(target, safe="")
        require_success(
            f"{label} join",
            request(
                "POST",
                SYNAPSE,
                f"/_matrix/client/v3/join/{encoded_target}",
                {},
                claimant_token,
            ),
        )
        members = require_success(
            f"{label} joined-member verification",
            request(
                "GET",
                SYNAPSE,
                f"/_matrix/client/v3/rooms/{encoded_target}/joined_members",
                token=creator_token,
            ),
        )
        if claimant_user not in members.get("joined", {}):
            raise RuntimeError(f"the admitted account did not join the {label}")

    resolve_status, resolve_error = request(
        "GET",
        ADMISSION,
        f"/v1/invitations/{admission_code}",
    )
    if resolve_status != 410 or resolve_error.get("code") != "invitation_used":
        raise RuntimeError("used invitation still resolved")
    claim_status, claim_error = request(
        "POST",
        ADMISSION,
        f"/v1/invitations/{admission_code}/claim",
        {"user_id": claimant_user},
    )
    if claim_status != 410 or claim_error.get("code") != "invitation_used":
        raise RuntimeError("used invitation could be claimed twice")

    print(
        "live admission acceptance passed: create, register, claim, "
        "join private channel, one-use"
    )


if __name__ == "__main__":
    main()
