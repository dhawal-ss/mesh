from __future__ import annotations

import dataclasses
import importlib.util
import io
import sqlite3
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import uuid
from http import HTTPStatus
from pathlib import Path
from typing import Any
from unittest import mock


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
                    "@mesh-admission-service:mesh.test"
                    if token == "admission-bot-token"
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
            service_user_id="@mesh-admission-service:mesh.test",
            service_access_token="admission-bot-token",
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
        self.issuer_calls: list[tuple[str, str, int]] = []
        self.store = admission.InvitationStore(self.config)
        self.application = admission.AdmissionApplication(
            self.config,
            self.store,
            self.matrix,
            lambda proof: str(proof["user_id"]),
            lambda action, token, expires_at: self.issuer_calls.append(
                (action, token, expires_at)
            ),
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def create(self) -> tuple[str, dict[str, Any]]:
        created = self.application.create_invitation(
            self.identity_proof(),
            "!community:mesh.test",
        )
        return urllib.parse.urlsplit(created["invite_url"]).fragment, created

    def identity_proof(self, **changes: Any) -> dict[str, Any]:
        proof: dict[str, Any] = {
            "proof_id": str(uuid.uuid4()),
            "purpose": "create",
            "subject": "!community:mesh.test",
            "audience": self.config.public_origin,
            "user_id": "@creator:mesh.test",
            "access_token": "short-lived-openid-proof",
            "token_type": "Bearer",
            "matrix_server_name": "mesh.test",
            "expires_in": 300,
        }
        proof.update(changes)
        return proof

    def claim_proof(self, code: str, user_id: str = "@claimant:public.test") -> dict[str, Any]:
        return self.identity_proof(
            purpose="claim",
            subject=code,
            user_id=user_id,
            matrix_server_name=user_id.split(":", 1)[1],
            access_token=f"short-lived-claim-openid-proof-{uuid.uuid4()}",
        )

    def claim(self, code: str, user_id: str = "@claimant:public.test") -> dict[str, Any]:
        return self.application.claim_invitation(code, user_id, self.claim_proof(code, user_id))

    def test_create_resolve_stores_only_digests_and_derived_registration(self) -> None:
        code, created = self.create()
        resolved = self.application.resolve_invitation(code)
        derived = admission.registration_token(self.config.signing_key, code)

        self.assertEqual(
            created["invite_url"],
            f"http://127.0.0.1:8090/invite#{code}",
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

    def test_signing_key_overlap_keeps_existing_invites_until_explicit_revocation(self) -> None:
        code, _ = self.create()
        old_key = self.config.signing_key
        old_key_id = self.config.signing_key_id
        new_key = bytes(reversed(range(32)))
        rotated = dataclasses.replace(
            self.config,
            signing_key=new_key,
            signing_key_id="0123456789abcdef",
            previous_signing_keys={old_key_id: old_key},
        )
        rotated_application = admission.AdmissionApplication(
            rotated,
            admission.InvitationStore(rotated),
            self.matrix,
            lambda proof: str(proof["user_id"]),
            lambda action, token, expires_at: self.issuer_calls.append(
                (action, token, expires_at)
            ),
        )

        resolved = rotated_application.resolve_invitation(code)
        self.assertEqual(
            resolved["registration_token"],
            admission.registration_token(old_key, code),
        )

        retired = dataclasses.replace(rotated, previous_signing_keys={})
        retired_application = admission.AdmissionApplication(
            retired,
            admission.InvitationStore(retired),
            self.matrix,
            lambda proof: str(proof["user_id"]),
            lambda *_: None,
        )
        with self.assertRaises(admission.AdmissionError) as context:
            retired_application.resolve_invitation(code)
        self.assertEqual(context.exception.code, "invitation_key_retired")

    def test_service_identity_is_bound_to_the_configured_non_admin_bot(self) -> None:
        self.application.verify_service_identity()
        self.assertIn(
            (
                "GET",
                "/_matrix/client/v3/account/whoami",
                None,
                "admission-bot-token",
            ),
            self.matrix.calls,
        )

    def test_claim_invites_once_and_invalidates_resolution(self) -> None:
        code, _ = self.create()
        whoami_before_claim = len([
            call for call in self.matrix.calls
            if call[1] == "/_matrix/client/v3/account/whoami"
        ])
        claimed = self.claim(code)

        self.assertEqual(claimed["room_id"], "!community:mesh.test")
        invite_calls = [
            call for call in self.matrix.calls if call[1].endswith("/invite")
        ]
        self.assertEqual(len(invite_calls), 2)
        self.assertEqual(
            invite_calls[0][2],
            {"user_id": "@claimant:public.test"},
        )
        self.assertEqual(
            len([
                call for call in self.matrix.calls
                if call[1] == "/_matrix/client/v3/account/whoami"
            ]),
            whoami_before_claim,
        )
        with self.assertRaises(admission.AdmissionError) as raised:
            self.application.resolve_invitation(code)
        self.assertEqual(raised.exception.code, "invitation_used")

    def test_claim_rejects_an_invalid_account_without_consuming_the_invitation(self) -> None:
        code, _ = self.create()
        with self.assertRaises(admission.AdmissionError) as raised:
            self.application.claim_invitation(code, "not-a-matrix-id", {})
        self.assertEqual(raised.exception.code, "user_id_invalid")
        self.assertEqual(
            self.application.resolve_invitation(code)["room_id"],
            "!community:mesh.test",
        )

    def test_failed_claim_releases_the_one_use_lease_for_safe_retry(self) -> None:
        code, _ = self.create()
        self.matrix.fail_next_invite = True

        with self.assertRaises(admission.AdmissionError):
            self.claim(code)
        self.assertEqual(
            self.application.resolve_invitation(code)["room_id"],
            "!community:mesh.test",
        )
        self.assertEqual(
            self.claim(code)["version"],
            4,
        )

    def test_existing_invite_makes_retry_idempotent(self) -> None:
        code, _ = self.create()
        self.matrix.claimant_memberships = {
            "%21community%3Amesh.test": "invite",
            "%21general%3Amesh.test": "invite",
        }

        self.claim(code)
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
            self.claim(code)
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

    def test_html_opens_the_app_without_sending_capability_in_http_path(self) -> None:
        code, _ = self.create()
        payload = self.application.invitation_html().decode("utf-8")
        derived = admission.registration_token(self.config.signing_key, code)

        self.assertIn('new URL("mesh://join")', payload)
        self.assertIn('window.location.hash.slice(1)', payload)
        self.assertIn('history.replaceState', payload)
        self.assertIn('target.searchParams.set("api"', payload)
        self.assertNotIn(code, payload)
        self.assertNotIn(derived, payload)
        self.assertIn("default-src 'none'", payload)
        self.assertIn("script-src 'nonce-", payload)

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
            lambda proof: str(proof["user_id"]),
            lambda action, token, expires_at: self.issuer_calls.append(
                (action, token, expires_at)
            ),
        )
        with self.assertRaises(admission.AdmissionError) as raised:
            application.create_invitation(
                self.identity_proof(),
                "!community:mesh.test",
            )
        self.assertEqual(raised.exception.code, "permission_denied")

    def test_create_never_sends_the_client_credential_to_matrix_or_admission_storage(self) -> None:
        proof = self.identity_proof(access_token="sentinel-client-openid-proof")
        self.application.create_invitation(proof, "!community:mesh.test")

        tokens = [call[3] for call in self.matrix.calls]
        self.assertNotIn("sentinel-client-openid-proof", tokens)
        room_checks = [
            call for call in self.matrix.calls
            if "/rooms/" in call[1] and "/state/" in call[1]
        ]
        self.assertTrue(room_checks)
        self.assertTrue(all(call[3] == "admission-bot-token" for call in room_checks))
        self.assertFalse(any("/_synapse/admin/" in call[1] for call in self.matrix.calls))
        connection = sqlite3.connect(self.config.sqlite_path)
        try:
            stored = " ".join(
                str(value)
                for row in connection.execute(
                    "SELECT proof_hash, user_id, audience FROM mesh_admission_openid_proofs"
                )
                for value in row
            )
        finally:
            connection.close()
        self.assertNotIn("sentinel-client-openid-proof", stored)

    def test_openid_proof_is_one_use(self) -> None:
        proof = self.identity_proof()
        self.application.create_invitation(proof, "!community:mesh.test")
        with self.assertRaises(admission.AdmissionError) as raised:
            self.application.create_invitation(proof, "!community:mesh.test")
        self.assertEqual(raised.exception.code, "identity_proof_replayed")

    def test_openid_credential_cannot_replay_under_new_uuid_purpose_or_subject(self) -> None:
        proof = self.identity_proof()
        created = self.application.create_invitation(proof, "!community:mesh.test")
        code = urllib.parse.urlsplit(created["invite_url"]).fragment
        replay = self.claim_proof(code, "@creator:mesh.test")
        replay["access_token"] = proof["access_token"]

        self.assertNotEqual(replay["proof_id"], proof["proof_id"])
        self.assertNotEqual(replay["purpose"], proof["purpose"])
        self.assertNotEqual(replay["subject"], proof["subject"])
        with self.assertRaises(admission.AdmissionError) as raised:
            self.application.claim_invitation(
                code,
                "@creator:mesh.test",
                replay,
            )
        self.assertEqual(raised.exception.code, "identity_proof_replayed")
        self.assertEqual(
            self.application.resolve_invitation(code)["room_id"],
            "!community:mesh.test",
        )

    def test_openid_proof_cannot_cross_admission_services(self) -> None:
        proof = self.identity_proof(audience="https://other-community.example")
        with self.assertRaises(admission.AdmissionError) as raised:
            self.application.create_invitation(proof, "!community:mesh.test")
        self.assertEqual(raised.exception.code, "identity_proof_invalid")

    def test_openid_verifier_must_confirm_the_claimed_user(self) -> None:
        application = admission.AdmissionApplication(
            self.config,
            self.store,
            self.matrix,
            lambda _proof: "@different:mesh.test",
            lambda action, token, expires_at: self.issuer_calls.append(
                (action, token, expires_at)
            ),
        )
        with self.assertRaises(admission.AdmissionError) as raised:
            application.create_invitation(
                self.identity_proof(),
                "!community:mesh.test",
            )
        self.assertEqual(raised.exception.code, "identity_proof_mismatch")

    def test_claim_requires_proof_for_the_same_user_and_operation(self) -> None:
        code, _ = self.create()
        wrong_user = self.claim_proof(code, "@different:public.test")
        with self.assertRaises(admission.AdmissionError) as raised:
            self.application.claim_invitation(
                code,
                "@claimant:public.test",
                wrong_user,
            )
        self.assertEqual(raised.exception.code, "identity_proof_mismatch")
        self.assertEqual(
            self.application.resolve_invitation(code)["room_id"],
            "!community:mesh.test",
        )

        create_proof = self.identity_proof(subject="!community:mesh.test")
        with self.assertRaises(admission.AdmissionError) as raised:
            self.application.claim_invitation(
                code,
                "@creator:mesh.test",
                create_proof,
            )
        self.assertEqual(raised.exception.code, "identity_proof_invalid")

    def test_claim_identity_proof_is_one_use(self) -> None:
        code, _ = self.create()
        proof = self.claim_proof(code)
        self.application.claim_invitation(code, "@claimant:public.test", proof)
        with self.assertRaises(admission.AdmissionError) as raised:
            self.application.claim_invitation(code, "@claimant:public.test", proof)
        self.assertEqual(raised.exception.code, "identity_proof_replayed")

    def test_production_default_fails_closed_without_post_capable_verifier(self) -> None:
        application = admission.AdmissionApplication(
            self.config,
            self.store,
            self.matrix,
        )
        with self.assertRaises(admission.AdmissionError) as raised:
            application.create_invitation(
                self.identity_proof(),
                "!community:mesh.test",
            )
        self.assertEqual(raised.exception.code, "identity_verifier_unavailable")

    def test_registration_issuance_fails_closed_without_a_scoped_provider(self) -> None:
        application = admission.AdmissionApplication(
            self.config,
            self.store,
            self.matrix,
            lambda proof: str(proof["user_id"]),
        )
        with self.assertRaises(admission.AdmissionError) as raised:
            application.create_invitation(
                self.identity_proof(),
                "!community:mesh.test",
            )
        self.assertEqual(raised.exception.code, "registration_issuer_unavailable")
        self.assertFalse(any("/_synapse/admin/" in call[1] for call in self.matrix.calls))

    def test_configuration_and_upstream_errors_do_not_expose_credentials(self) -> None:
        redacted = dataclasses.replace(
            self.config,
            service_access_token="sentinel-service-access-token",
            signing_key=b"sentinel-signing-key-material",
            postgres_password="sentinel-postgres-password",
        )
        representation = repr(redacted)
        self.assertNotIn("sentinel-service-access-token", representation)
        self.assertNotIn("sentinel-signing-key-material", representation)
        self.assertNotIn("sentinel-postgres-password", representation)

        reflected = b'{"error":"sentinel-reflected-credential"}'
        upstream_error = urllib.error.HTTPError(
            "http://synapse:8008/test",
            HTTPStatus.FORBIDDEN,
            "Forbidden",
            {},
            io.BytesIO(reflected),
        )
        with mock.patch.object(
            admission.urllib.request,
            "urlopen",
            side_effect=upstream_error,
        ):
            with self.assertRaises(admission.AdmissionError) as raised:
                self.application._matrix_request(
                    "GET",
                    "/test",
                    None,
                    "sentinel-service-access-token",
                )
        self.assertNotIn("sentinel-reflected-credential", str(raised.exception))
        self.assertNotIn("sentinel-service-access-token", str(raised.exception))

        bootstrap_source = (MODULE_PATH.parent / "bootstrap_admission_service.py").read_text(
            encoding="utf-8"
        )
        self.assertNotIn("Synapse returned HTTP {error.code}: {detail}", bootstrap_source)


if __name__ == "__main__":
    unittest.main()
