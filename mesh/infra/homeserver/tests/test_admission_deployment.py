from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def service_block(compose: str, service: str, next_service: str) -> str:
    start = compose.index(f"\n  {service}:\n")
    end = compose.index(f"\n  {next_service}:\n", start)
    return compose[start:end]


class AdmissionDeploymentContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
        cls.caddy = (ROOT / "Caddyfile").read_text(encoding="utf-8")
        cls.provision = (ROOT / "provision-admission-database.sh").read_text(
            encoding="utf-8"
        )
        cls.start = (ROOT / "start.sh").read_text(encoding="utf-8")
        cls.admission = (ROOT / "admission_service.py").read_text(encoding="utf-8")

    def test_admission_receives_only_allowlisted_runtime_settings(self) -> None:
        block = service_block(self.compose, "admission", "caddy")
        self.assertNotIn("env_file:", block)
        self.assertNotIn("REGISTRATION_SHARED_SECRET", block)
        self.assertNotIn("MACAROON_SECRET_KEY", block)
        self.assertNotIn("FORM_SECRET", block)
        self.assertNotIn('${POSTGRES_PASSWORD', block)
        self.assertIn(
            'POSTGRES_PASSWORD: "${MESH_ADMISSION_DB_PASSWORD:', block
        )

    def test_admission_container_and_networks_are_fail_closed(self) -> None:
        block = service_block(self.compose, "admission", "caddy")
        for boundary in (
            "read_only: true",
            "cap_drop:\n      - ALL",
            "pids_limit: 64",
            'cpus: "0.50"',
            "/tmp:size=16m,mode=1770,noexec,nosuid,nodev",
            "- admission-db",
            "- admission-control",
        ):
            self.assertIn(boundary, block)
        self.assertNotIn("- synapse-db", block)
        self.assertNotIn("- matrix-edge", block)
        self.assertIn("admission-control:\n    driver: bridge\n    internal: true", self.compose)
        self.assertIn("admission-db:\n    driver: bridge\n    internal: true", self.compose)

    def test_runtime_role_is_limited_to_the_two_admission_tables(self) -> None:
        self.assertIn("CREATE ROLE mesh_admission_owner NOLOGIN", self.provision)
        self.assertIn("REVOKE ALL ON SCHEMA public FROM PUBLIC", self.provision)
        self.assertIn("Admission runtime role can read Synapse tables", self.provision)
        self.assertIn("Admission runtime role can create tables", self.provision)
        grants = self.provision.split("GRANT SELECT, INSERT, UPDATE, DELETE", 1)[1]
        grants = grants.split("ALTER DEFAULT PRIVILEGES", 1)[0]
        self.assertIn("mesh_admission.mesh_admission_invitations", grants)
        self.assertIn("mesh_admission.mesh_admission_openid_proofs", grants)
        self.assertNotIn("public.", grants)
        self.assertLess(
            self.start.index("sh ./provision-admission-database.sh"),
            self.start.index("docker compose up -d admission"),
        )

    def test_production_runtime_cannot_create_or_migrate_tables(self) -> None:
        initialize = self.admission.split("def initialize(self)", 1)[1].split(
            "def healthy(self)", 1
        )[0]
        self.assertIn("if self.sqlite:", initialize)
        production = initialize.split("else:", 1)[1]
        self.assertNotIn("CREATE TABLE", production)
        self.assertIn("SELECT 1 FROM mesh_admission_invitations LIMIT 0", production)
        self.assertIn("SELECT 1 FROM mesh_admission_openid_proofs LIMIT 0", production)

    def test_public_admission_routes_remain_disabled(self) -> None:
        self.assertNotIn("reverse_proxy admission", self.caddy)
        self.assertGreaterEqual(
            self.caddy.count('respond "Community invitations are not available." 404'),
            2,
        )

    def test_well_known_responses_use_bounded_public_caching(self) -> None:
        self.assertEqual(
            self.caddy.count('header Cache-Control "public, max-age=300"'),
            2,
        )


if __name__ == "__main__":
    unittest.main()
