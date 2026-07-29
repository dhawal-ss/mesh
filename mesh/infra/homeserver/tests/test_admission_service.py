from __future__ import annotations

import importlib.util
import sqlite3
import sys
import tempfile
import time
import unittest
from http import HTTPStatus
from pathlib import Path
from typing import Any


MODULE_PATH = Path(__file__).resolve().parents[1] / "admission_service.py"
SPEC = importlib.util.spec_from_file_location("mesh_admission_service", MODULE_PATH)
assert SPEC and SPEC.loader
admission = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = admission
SPEC.loader.exec_module(admission)


class FakeMatrix:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict[str, Any] | None, str | None]] = []
        self.child_rooms = ["!general:mesh.test"]
        self.claimant_memberships: dict[str, str] = {}
        self.fail_next_invite = False

    def __call__(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None,
        token: str | None,
    ) -> dict[str, Any]:
        self.calls.append((method, path, body, token))
        if path == "/_matrix/client/v3/account/whoami":
            return {
                "user_id": (
                    "@creator:mesh.test"
                    if token == "creator-token"
                    else "@claimant:mesh.test"
                )
            }
        if path.endswith("/state/m.room.create"):
            return {"type": "m.space"}
        if "/state/m.room.member/" in path:
            if "%40creator%3Amesh.test" in path:
                return {"membership": "join"}
            encoded_room = path.split("/rooms/", 1)[1].split("/", 1)[0]
            if encoded_room in self.claimant_memberships:
                return {"membership": self.claimant_memberships[encoded_room]}
            raise admission.AdmissionError(
                HTTPStatus.NOT_FOUND,
                "not_found",
                "No membership exists.",
            )
        if path.endswith("/state/m.room.power_levels"):
            return {
                "users": {"@creator:mesh.test": 100},
                "users_default": 0,
                "invite": 50,
                "state_default": 50,
            }
        if path.endswith("/state"):
            return [
                {
                    "type": "m.space.child",
                    "state_key": room_id,
                    "content": {"via": ["mesh.test"]},
                }
                for room_id in self.child_rooms
            ]
        if path == "/_synapse/admin/v1/registration_tokens/new":
            return {}
        if path.endswith("/login") and path.startswith("/_synapse/admin/v1/users/"):
            return {"access_token": "temporary-creator-token"}
        if path.endswith("/invite"):
            if self.fail_next_invite:
                self.fail_next_invite = False
                raise admission.AdmissionError(
                    HTTPStatus.FORBIDDEN,
                    "permission_denied",
                    "Creator can no longer invite.",
                )
            encoded_room = path.split("/rooms/", 1)[1].split("/", 1)[0]
            self.claimant_memberships[encoded_room] = "invite"
            return {}
        if path == "/_matrix/client/v3/logout":
            return {}
        if path.startswith("/_synapse/admin/v1/registration_tokens/"):
            return {}
        raise AssertionError(f"Unexpected Matrix request: {method} {path}")


class AdmissionServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        sqlite_path = str(Path(self.temporary.name) / "admission.sqlite3")
        self.config = admission.Config(
            server_name="mesh.test",
            homeserver_public_url="http://127.0.0.1:8008",
            homeserver_internal_url="http://synapse:8008",
            public_origin="http://127.0.0.1:8090",
            admin_access_token="service-admin-token",
            signing_key=bytes(range(32)),
            postgres_host=None,
            postgres_port=5432,
            postgres_user=None,
            postgres_password=None,
            postgres_database=None,
            sqlite_path=sqlite_path,
            bind_host="127.0.0.1",
            bind_port=8090,
        )
        self.matrix = FakeMatrix()
        self.store = admission.InvitationStore(self.config)
        self.application = admission.AdmissionApplication(
            self.config,
            self.store,
            self.matrix,
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def create(self) -> tuple[str, dict[str, Any]]:
        created = self.application.create_invitation(
            "creator-token",
            "!community:mesh.test",
        )
        return created["invite_url"].rsplit("/", 1)[1], created

    def test_create_resolve_stores_only_digests_and_derived_registration(self) -> None:
        code, created = self.create()
        resolved = self.application.resolve_invitation(code)
        derived = admission.registration_token(self.config.signing_key, code)

        self.assertEqual(
            created["invite_url"],
            f"http://127.0.0.1:8090/invite/{code}",
        )
        self.assertEqual(resolved["registration_token"], derived)
        self.assertEqual(resolved["room_id"], "!community:mesh.test")
        self.assertEqual(resolved["via"], ["mesh.test"])

        connection = sqlite3.connect(self.config.sqlite_path)
        try:
            stored = connection.execute(
                "SELECT token_hash FROM mesh_admission_invitations"
            ).fetchone()[0]
        finally:
            connection.close()
        self.assertEqual(stored, admission.token_digest(code))
        self.assertNotEqual(stored, code)
        self.assertNotEqual(stored, derived)

    def test_claim_invites_once_and_invalidates_resolution(self) -> None:
        code, _ = self.create()
        claimed = self.application.claim_invitation(code, "claimant-token")

        self.assertEqual(claimed["room_id"], "!community:mesh.test")
        invite_calls = [
            call for call in self.matrix.calls if call[1].endswith("/invite")
        ]
        self.assertEqual(len(invite_calls), 2)
        self.assertEqual(
            invite_calls[0][2],
            {"user_id": "@claimant:mesh.test"},
        )
        with self.assertRaises(admission.AdmissionError) as raised:
            self.application.resolve_invitation(code)
        self.assertEqual(raised.exception.code, "invitation_used")

    def test_failed_claim_releases_the_one_use_lease_for_safe_retry(self) -> None:
        code, _ = self.create()
        self.matrix.fail_next_invite = True

        with self.assertRaises(admission.AdmissionError):
            self.application.claim_invitation(code, "claimant-token")
        self.assertEqual(
            self.application.resolve_invitation(code)["room_id"],
            "!community:mesh.test",
        )
        self.assertEqual(
            self.application.claim_invitation(code, "claimant-token")["version"],
            4,
        )

    def test_existing_invite_makes_retry_idempotent(self) -> None:
        code, _ = self.create()
        self.matrix.claimant_memberships = {
            "%21community%3Amesh.test": "invite",
            "%21general%3Amesh.test": "invite",
        }

        self.application.claim_invitation(code, "claimant-token")
        invite_calls = [
            call for call in self.matrix.calls if call[1].endswith("/invite")
        ]
        self.assertEqual(invite_calls, [])

    def test_oversized_community_releases_claim_without_unbounded_invites(self) -> None:
        code, _ = self.create()
        self.matrix.child_rooms = [
            f"!room{index}:mesh.test"
            for index in range(admission.MAX_COMMUNITY_ROOMS + 1)
        ]

        with self.assertRaises(admission.AdmissionError) as raised:
            self.application.claim_invitation(code, "claimant-token")
        self.assertEqual(raised.exception.code, "community_too_large")
        self.assertEqual(
            self.application.resolve_invitation(code)["room_id"],
            "!community:mesh.test",
        )

    def test_claim_lease_cannot_be_acquired_by_two_callers(self) -> None:
        code, _ = self.create()
        digest = admission.token_digest(code)
        now_ms = int(time.time() * 1000)
        self.store.begin_claim(digest, "@first:mesh.test", now_ms)
        with self.assertRaises(admission.AdmissionError) as raised:
            self.store.begin_claim(digest, "@second:mesh.test", now_ms)
        self.assertEqual(raised.exception.code, "invitation_claiming")

    def test_html_opens_the_app_without_embedding_registration_admission(self) -> None:
        code, _ = self.create()
        payload = self.application.invitation_html(code).decode("utf-8")
        derived = admission.registration_token(self.config.signing_key, code)

        self.assertIn("mesh://join?", payload)
        self.assertIn(code, payload)
        self.assertNotIn(derived, payload)
        self.assertIn("default-src 'none'", payload)

    def test_non_administrator_cannot_create_a_link(self) -> None:
        original = self.matrix

        def insufficient_power(
            method: str,
            path: str,
            body: dict[str, Any] | None,
            token: str | None,
        ) -> dict[str, Any]:
            response = original(method, path, body, token)
            if path.endswith("/state/m.room.power_levels"):
                response["users"]["@creator:mesh.test"] = 49
            return response

        application = admission.AdmissionApplication(
            self.config,
            self.store,
            insufficient_power,
        )
        with self.assertRaises(admission.AdmissionError) as raised:
            application.create_invitation(
                "creator-token",
                "!community:mesh.test",
            )
        self.assertEqual(raised.exception.code, "permission_denied")


if __name__ == "__main__":
    unittest.main()
