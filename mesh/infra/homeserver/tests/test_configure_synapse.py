from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import yaml


MODULE_PATH = Path(__file__).resolve().parents[1] / "configure_synapse.py"
SPEC = importlib.util.spec_from_file_location("mesh_configure_synapse", MODULE_PATH)
assert SPEC and SPEC.loader
configure = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = configure
SPEC.loader.exec_module(configure)


class ConfigureSynapseTests(unittest.TestCase):
    def render(
        self,
        registration_enabled: str = "1",
        abuse_email: str | None = "abuse@community.test",
    ) -> dict[str, object]:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "homeserver.yaml"
            path.write_text("{}\n", encoding="utf-8")
            environment = {
                "MESH_SERVER_NAME": "community.test",
                "MESH_HOMESERVER_HOST": "matrix.community.test",
                "MESH_REGISTRATION_ENABLED": registration_enabled,
                "POSTGRES_USER": "synapse",
                "POSTGRES_PASSWORD": "test-password",
                "POSTGRES_DB": "synapse",
                "REGISTRATION_SHARED_SECRET": "registration-secret",
                "MACAROON_SECRET_KEY": "macaroon-secret",
                "FORM_SECRET": "form-secret",
            }
            if abuse_email is not None:
                environment["MESH_ABUSE_EMAIL"] = abuse_email
            with (
                mock.patch.dict(os.environ, environment, clear=True),
                mock.patch.object(sys, "argv", ["configure_synapse.py", str(path)]),
            ):
                configure.main()
            return yaml.safe_load(path.read_text(encoding="utf-8"))

    def test_applies_bounded_community_service_defaults(self) -> None:
        rendered = self.render()

        self.assertTrue(rendered["enable_registration"])
        self.assertFalse(rendered["enable_registration_without_verification"])
        self.assertTrue(rendered["registration_requires_token"])
        self.assertEqual(rendered["admin_contact"], "mailto:abuse@community.test")
        self.assertEqual(rendered["max_upload_size"], "100M")
        self.assertFalse(rendered["retention"]["enabled"])
        self.assertEqual(rendered["media_retention"]["remote_media_lifetime"], "30d")
        self.assertEqual(rendered["rc_federation"]["concurrent"], 3)
        self.assertEqual(rendered["rc_login"]["failed_attempts"]["burst_count"], 5)

    def test_emergency_switch_closes_registration(self) -> None:
        rendered = self.render("0")
        self.assertFalse(rendered["enable_registration"])

    def test_rejects_ambiguous_registration_switches(self) -> None:
        with self.assertRaises(SystemExit):
            self.render("sometimes")

    def test_requires_an_explicit_abuse_contact(self) -> None:
        with self.assertRaisesRegex(SystemExit, "MESH_ABUSE_EMAIL"):
            self.render(abuse_email=None)


if __name__ == "__main__":
    unittest.main()
