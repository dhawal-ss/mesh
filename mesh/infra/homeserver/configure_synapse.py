#!/usr/bin/env python3
"""Apply Mesh's production-safe Synapse settings to a generated config."""

from __future__ import annotations

import os
import pathlib
import sys

import yaml


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value or value.startswith("REPLACE_"):
        raise SystemExit(f"{name} is missing or still contains a placeholder")
    return value


def boolean_environment(name: str, default: bool) -> bool:
    value = os.environ.get(name, "1" if default else "0").strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    raise SystemExit(f"{name} must be 0/1 or true/false")


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: configure_synapse.py /data/homeserver.yaml")

    config_path = pathlib.Path(sys.argv[1])
    config = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}

    server_name = required("MESH_SERVER_NAME")
    homeserver_host = required("MESH_HOMESERVER_HOST")
    abuse_email = required("MESH_ABUSE_EMAIL")
    registration_enabled = boolean_environment("MESH_REGISTRATION_ENABLED", True)

    config.update(
        {
            "server_name": server_name,
            "public_baseurl": f"https://{homeserver_host}/",
            "pid_file": "/data/homeserver.pid",
            "report_stats": False,
            "listeners": [
                {
                    "port": 8008,
                    "type": "http",
                    "tls": False,
                    "x_forwarded": True,
                    "bind_addresses": ["0.0.0.0"],
                    "resources": [
                        {
                            "names": ["client", "federation"],
                            "compress": False,
                        }
                    ],
                }
            ],
            "database": {
                "name": "psycopg2",
                "txn_limit": 10000,
                "args": {
                    "user": required("POSTGRES_USER"),
                    "password": required("POSTGRES_PASSWORD"),
                    "dbname": required("POSTGRES_DB"),
                    "host": "postgres",
                    "port": 5432,
                    "cp_min": 1,
                    "cp_max": 5,
                },
            },
            "media_store_path": "/data/media_store",
            "max_upload_size": "100M",
            "enable_media_repo": True,
            "media_retention": {
                "remote_media_lifetime": "30d",
            },
            # Community content has no automatic deletion policy by default.
            # Operators must announce and review any future retention change
            # before applying it to existing rooms.
            "retention": {
                "enabled": False,
            },
            "url_preview_enabled": False,
            "enable_registration": registration_enabled,
            "enable_registration_without_verification": False,
            "registration_requires_token": True,
            "allow_guest_access": False,
            "registration_shared_secret": required("REGISTRATION_SHARED_SECRET"),
            "macaroon_secret_key": required("MACAROON_SECRET_KEY"),
            "form_secret": required("FORM_SECRET"),
            "password_config": {
                "enabled": True,
                "localdb_enabled": True,
            },
            "allow_public_rooms_without_auth": False,
            "allow_public_rooms_over_federation": False,
            "admin_contact": f"mailto:{abuse_email}",
            "rc_login": {
                "address": {"per_second": 0.17, "burst_count": 5},
                "account": {"per_second": 0.17, "burst_count": 5},
                "failed_attempts": {"per_second": 0.17, "burst_count": 5},
            },
            "rc_registration": {"per_second": 0.01, "burst_count": 2},
            "rc_message": {"per_second": 0.5, "burst_count": 20},
            "rc_joins": {
                "local": {"per_second": 0.1, "burst_count": 10},
                "remote": {"per_second": 0.01, "burst_count": 10},
            },
            "rc_invites": {
                "per_room": {"per_second": 0.1, "burst_count": 10},
                "per_user": {"per_second": 0.01, "burst_count": 10},
            },
            "rc_federation": {
                "window_size": 1_000,
                "sleep_limit": 10,
                "sleep_delay": 500,
                "reject_limit": 50,
                "concurrent": 3,
            },
            "serve_server_wellknown": False,
            "trusted_key_servers": [{"server_name": "matrix.org"}],
            "suppress_key_server_warning": True,
        }
    )

    rendered = yaml.safe_dump(config, sort_keys=False, default_flow_style=False)
    temporary_path = config_path.with_suffix(".yaml.tmp")
    temporary_path.write_text(rendered, encoding="utf-8")
    temporary_path.chmod(0o600)
    temporary_path.replace(config_path)
    config_path.chmod(0o600)


if __name__ == "__main__":
    main()
