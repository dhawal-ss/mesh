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


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: configure_synapse.py /data/homeserver.yaml")

    config_path = pathlib.Path(sys.argv[1])
    config = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}

    server_name = required("MESH_SERVER_NAME")
    homeserver_host = required("MESH_HOMESERVER_HOST")

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
            "url_preview_enabled": False,
            "enable_registration": True,
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
