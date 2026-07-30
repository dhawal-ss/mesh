#!/usr/bin/env python3
"""Create a bounded Synapse registration token without exposing admin credentials."""

from __future__ import annotations

import argparse
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request


BASE_URL = "http://127.0.0.1:8008"


def request_json(
    method: str,
    path: str,
    body: dict[str, object],
    access_token: str | None = None,
) -> dict[str, object]:
    headers = {"Content-Type": "application/json"}
    if access_token:
        headers["Authorization"] = f"Bearer {access_token}"
    request = urllib.request.Request(
        f"{BASE_URL}{path}",
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise SystemExit(f"Mesh account service returned HTTP {error.code}") from None
    except urllib.error.URLError:
        raise SystemExit("Mesh account service is not reachable on the local control port") from None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--uses", type=int, default=1)
    args = parser.parse_args()
    if not 1 <= args.days <= 30:
        raise SystemExit("--days must be between 1 and 30")
    if not 1 <= args.uses <= 25:
        raise SystemExit("--uses must be between 1 and 25")

    server_name = os.environ.get("MESH_SERVER_NAME", "").strip()
    operator_localpart = os.environ.get("MESH_OPERATOR_LOCALPART", "").strip()
    admin_password = os.environ.get("MESH_ADMIN_PASSWORD", "")
    if (
        not server_name
        or not re.fullmatch(r"[a-z0-9._=-]{1,64}", operator_localpart)
        or not admin_password
    ):
        raise SystemExit("operator identity is not available")

    login = request_json(
        "POST",
        "/_matrix/client/v3/login",
        {
            "type": "m.login.password",
            "identifier": {
                "type": "m.id.user",
                "user": f"@{operator_localpart}:{server_name}",
            },
            "password": admin_password,
            "initial_device_display_name": "Mesh invitation operator",
        },
    )
    access_token = str(login.get("access_token", ""))
    if not access_token:
        raise SystemExit("operator sign-in returned no access token")

    try:
        created = request_json(
            "POST",
            "/_synapse/admin/v1/registration_tokens/new",
            {
                "length": 32,
                "uses_allowed": args.uses,
                "expiry_time": int((time.time() + args.days * 86400) * 1000),
            },
            access_token,
        )
    finally:
        try:
            request_json("POST", "/_matrix/client/v3/logout", {}, access_token)
        except SystemExit:
            pass

    token = str(created.get("token", ""))
    if not token:
        raise SystemExit("account service returned no invitation code")

    query = {"registration_token": token}
    invite_url = f"https://{server_name}/invite?{urllib.parse.urlencode(query)}"

    print(f"Invitation code: {token}")
    print(f"Invitation link: {invite_url}")
    print(f"Valid for {args.days} day(s), with {args.uses} allowed use(s).")


if __name__ == "__main__":
    main()
