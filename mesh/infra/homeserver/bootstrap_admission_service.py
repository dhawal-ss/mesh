#!/usr/bin/env python3
"""Create the dedicated admission administrator and print a fresh access token.

Passwords are read from stdin so they do not appear in the process list. The
only stdout output is the service access token consumed by start.sh.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


BASE_URL = "http://127.0.0.1:8008"


def request(
    method: str,
    path: str,
    body: dict[str, Any],
    access_token: str | None = None,
) -> dict[str, Any]:
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if access_token:
        headers["Authorization"] = f"Bearer {access_token}"
    operation = urllib.request.Request(
        f"{BASE_URL}{path}",
        data=json.dumps(body, separators=(",", ":")).encode("utf-8"),
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(operation, timeout=15) as response:
            payload = response.read(64 * 1024 + 1)
    except urllib.error.HTTPError as error:
        detail = error.read(8 * 1024).decode("utf-8", "replace")
        raise RuntimeError(f"Synapse returned HTTP {error.code}: {detail}") from None
    if len(payload) > 64 * 1024:
        raise RuntimeError("Synapse returned an oversized response")
    return json.loads(payload or b"{}")


def login(user: str, password: str, device_name: str) -> str:
    response = request(
        "POST",
        "/_matrix/client/v3/login",
        {
            "type": "m.login.password",
            "identifier": {"type": "m.id.user", "user": user},
            "password": password,
            "initial_device_display_name": device_name,
        },
    )
    access_token = str(response.get("access_token", ""))
    if not access_token:
        raise RuntimeError("Synapse login returned no access token")
    return access_token


def main() -> None:
    server_name = os.environ["MESH_SERVER_NAME"]
    operator_user = os.environ["MESH_OPERATOR_USER"]
    service_localpart = os.environ.get(
        "MESH_ADMISSION_SERVICE_LOCALPART",
        "mesh-admission-service",
    )
    operator_password = sys.stdin.readline().rstrip("\r\n")
    service_password = sys.stdin.readline().rstrip("\r\n")
    if not operator_password or not service_password:
        raise RuntimeError("operator and service passwords are required on stdin")

    operator_token = login(operator_user, operator_password, "Mesh operator bootstrap")
    service_user = f"@{service_localpart}:{server_name}"
    encoded_service_user = urllib.parse.quote(service_user, safe="")
    try:
        request(
            "PUT",
            f"/_synapse/admin/v2/users/{encoded_service_user}",
            {
                "password": service_password,
                "admin": True,
                "deactivated": False,
                "displayname": "Mesh admission service",
            },
            operator_token,
        )
        service_token = login(
            service_user,
            service_password,
            "Mesh admission service",
        )
    finally:
        try:
            request(
                "POST",
                "/_matrix/client/v3/logout",
                {},
                operator_token,
            )
        except Exception:
            pass

    print(service_token)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Could not provision the Mesh admission service: {error}", file=sys.stderr)
        raise SystemExit(1) from None
