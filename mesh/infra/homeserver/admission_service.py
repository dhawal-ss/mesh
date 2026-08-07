#!/usr/bin/env python3
"""Bounded invitations for an optional community-hosted Mesh service.

The public invitation is an opaque bearer capability. Only its SHA-256 digest
is stored. A separate deterministic Synapse registration token is derived with
HMAC so the database does not retain either raw credential.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Protocol


ADMISSION_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32,64}$")
ROOM_ID_PATTERN = re.compile(r"^![^\s:]{1,255}:[^\s]{1,255}$")
USER_ID_PATTERN = re.compile(r"^@[^\s:]{1,255}:[^\s]{1,255}$")
MAX_BODY_BYTES = 16 * 1024
MAX_AUTHORIZATION_BYTES = 8 * 1024
MAX_MATRIX_RESPONSE_BYTES = 1024 * 1024
MAX_COMMUNITY_ROOMS = 500
DEFAULT_EXPIRY_SECONDS = 7 * 24 * 60 * 60
MIN_EXPIRY_SECONDS = 60 * 60
MAX_EXPIRY_SECONDS = 30 * 24 * 60 * 60
CLAIM_LEASE_SECONDS = 90
MAX_OPENID_PROOF_SECONDS = 60 * 60


class AdmissionError(Exception):
    def __init__(self, status: HTTPStatus, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


@dataclass(frozen=True)
class Config:
    server_name: str
    homeserver_public_url: str
    homeserver_internal_url: str
    public_origin: str
    service_user_id: str
    service_access_token: str = field(repr=False)
    signing_key: bytes = field(repr=False)
    postgres_host: str | None
    postgres_port: int
    postgres_user: str | None
    postgres_password: str | None = field(repr=False)
    postgres_database: str | None
    sqlite_path: str | None
    bind_host: str
    bind_port: int
    signing_key_id: str = "primary"
    previous_signing_keys: dict[str, bytes] = field(default_factory=dict, repr=False)

    @classmethod
    def from_environment(cls) -> "Config":
        server_name = required("MESH_SERVER_NAME")
        homeserver_public_url = normalize_origin(
            required("MESH_HOMESERVER_PUBLIC_URL"),
            allow_private_http=True,
        )
        homeserver_internal_url = normalize_origin(
            os.environ.get("MESH_HOMESERVER_INTERNAL_URL", "http://synapse:8008"),
            allow_private_http=True,
        )
        public_origin = normalize_origin(
            required("MESH_PUBLIC_ORIGIN"),
            allow_private_http=True,
        )
        service_user_id = required("MESH_ADMISSION_SERVICE_USER_ID")
        service_access_token = required("MESH_ADMISSION_SERVICE_ACCESS_TOKEN")
        if not USER_ID_PATTERN.fullmatch(service_user_id) or service_user_id.split(":", 1)[1] != server_name:
            raise SystemExit("MESH_ADMISSION_SERVICE_USER_ID must be a local Matrix user ID")
        signing_key_text = required("MESH_ADMISSION_SIGNING_KEY")
        try:
            signing_key = bytes.fromhex(signing_key_text)
        except ValueError as error:
            raise SystemExit("MESH_ADMISSION_SIGNING_KEY must be hexadecimal") from error
        if len(signing_key) < 32:
            raise SystemExit("MESH_ADMISSION_SIGNING_KEY must contain at least 32 bytes")
        expected_signing_key_id = hashlib.sha256(signing_key).hexdigest()[:16]
        signing_key_id = os.environ.get("MESH_ADMISSION_SIGNING_KEY_ID", "").strip()
        if not signing_key_id:
            signing_key_id = expected_signing_key_id
        validate_signing_key_id(signing_key_id)
        if not hmac.compare_digest(signing_key_id, expected_signing_key_id):
            raise SystemExit(
                "MESH_ADMISSION_SIGNING_KEY_ID must match the configured signing key"
            )
        previous_signing_keys: dict[str, bytes] = {}
        for item in filter(None, os.environ.get("MESH_ADMISSION_PREVIOUS_SIGNING_KEYS", "").split(",")):
            key_id, separator, key_hex = item.partition(":")
            if not separator:
                raise SystemExit("MESH_ADMISSION_PREVIOUS_SIGNING_KEYS is invalid")
            validate_signing_key_id(key_id)
            try:
                previous_key = bytes.fromhex(key_hex)
            except ValueError as error:
                raise SystemExit("A previous admission signing key is not hexadecimal") from error
            if len(previous_key) < 32 or key_id == signing_key_id:
                raise SystemExit(
                    "Previous admission signing keys must be distinct keys of at least 32 bytes"
                )
            expected_previous_key_id = hashlib.sha256(previous_key).hexdigest()[:16]
            if not hmac.compare_digest(key_id, expected_previous_key_id):
                raise SystemExit(
                    "Each previous admission signing key ID must match its signing key"
                )
            if key_id in previous_signing_keys:
                raise SystemExit("Previous admission signing key IDs must be unique")
            previous_signing_keys[key_id] = previous_key

        sqlite_path = os.environ.get("MESH_ADMISSION_SQLITE_PATH", "").strip() or None
        postgres_host = os.environ.get("POSTGRES_HOST", "postgres").strip() or None
        postgres_user = os.environ.get("POSTGRES_USER", "").strip() or None
        postgres_password = os.environ.get("POSTGRES_PASSWORD", "") or None
        postgres_database = os.environ.get("POSTGRES_DB", "").strip() or None
        if sqlite_path is None and not all(
            (postgres_host, postgres_user, postgres_password, postgres_database)
        ):
            raise SystemExit("PostgreSQL settings are required outside SQLite development mode")

        return cls(
            server_name=server_name,
            homeserver_public_url=homeserver_public_url,
            homeserver_internal_url=homeserver_internal_url,
            public_origin=public_origin,
            service_user_id=service_user_id,
            service_access_token=service_access_token,
            signing_key=signing_key,
            postgres_host=postgres_host,
            postgres_port=integer_environment("POSTGRES_PORT", 5432, 1, 65535),
            postgres_user=postgres_user,
            postgres_password=postgres_password,
            postgres_database=postgres_database,
            sqlite_path=sqlite_path,
            bind_host=os.environ.get("MESH_ADMISSION_BIND", "0.0.0.0"),
            bind_port=integer_environment("MESH_ADMISSION_PORT", 8090, 1, 65535),
            signing_key_id=signing_key_id,
            previous_signing_keys=previous_signing_keys,
        )


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value or value.startswith("REPLACE_"):
        raise SystemExit(f"{name} is missing or still contains a placeholder")
    return value


def integer_environment(name: str, default: int, minimum: int, maximum: int) -> int:
    value = os.environ.get(name, str(default))
    try:
        parsed = int(value)
    except ValueError as error:
        raise SystemExit(f"{name} must be an integer") from error
    if not minimum <= parsed <= maximum:
        raise SystemExit(f"{name} must be between {minimum} and {maximum}")
    return parsed


def validate_signing_key_id(value: str) -> None:
    if not re.fullmatch(r"[a-f0-9]{16}", value):
        raise SystemExit("Admission signing key IDs must be 16 lowercase hexadecimal characters")


def normalize_origin(value: str, allow_private_http: bool = False) -> str:
    parsed = urllib.parse.urlparse(value.strip())
    if (
        not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.params
        or parsed.query
        or parsed.fragment
        or parsed.path not in ("", "/")
    ):
        raise SystemExit("Mesh service origins must not contain credentials, paths, or queries")
    if parsed.scheme == "https":
        return value.strip().rstrip("/")
    if parsed.scheme != "http" or not allow_private_http:
        raise SystemExit("Mesh service origins must use HTTPS")
    try:
        address = ipaddress.ip_address(parsed.hostname)
        private = address.is_private or address.is_loopback
    except ValueError:
        private = parsed.hostname in {"localhost", "synapse"}
    if not private:
        raise SystemExit("HTTP is allowed only for private development services")
    return value.strip().rstrip("/")


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def registration_token(signing_key: bytes, admission_token: str) -> str:
    digest = hmac.new(
        signing_key,
        b"mesh-registration-v1\0" + admission_token.encode("ascii"),
        hashlib.sha256,
    ).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def invitation_signing_key(config: Config, key_id: str) -> bytes:
    if key_id == config.signing_key_id:
        return config.signing_key
    key = config.previous_signing_keys.get(key_id)
    if key is None:
        raise AdmissionError(
            HTTPStatus.GONE,
            "invitation_key_retired",
            "This invitation was signed with a retired key. Ask for a new invitation.",
        )
    return key


class Cursor(Protocol):
    rowcount: int

    def execute(self, query: str, parameters: tuple[Any, ...] = ()) -> Any: ...

    def fetchone(self) -> Any: ...


class Connection(Protocol):
    def cursor(self) -> Cursor: ...

    def commit(self) -> None: ...

    def rollback(self) -> None: ...

    def close(self) -> None: ...


class InvitationStore:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.sqlite = config.sqlite_path is not None
        self._initialize_lock = threading.Lock()
        self._initialized = False

    def connect(self) -> Connection:
        if self.sqlite:
            connection = sqlite3.connect(
                self.config.sqlite_path or ":memory:",
                timeout=15,
                isolation_level=None,
            )
            connection.row_factory = sqlite3.Row
            return connection

        try:
            import psycopg2
        except ImportError as error:
            raise RuntimeError("psycopg2 is required for the production admission store") from error
        return psycopg2.connect(
            host=self.config.postgres_host,
            port=self.config.postgres_port,
            user=self.config.postgres_user,
            password=self.config.postgres_password,
            dbname=self.config.postgres_database,
            connect_timeout=10,
            application_name="mesh-admission-service",
        )

    @property
    def placeholder(self) -> str:
        return "?" if self.sqlite else "%s"

    def initialize(self) -> None:
        if self._initialized:
            return
        with self._initialize_lock:
            if self._initialized:
                return
            connection = self.connect()
            try:
                cursor = connection.cursor()
                if self.sqlite:
                    cursor.execute(
                        """
                        CREATE TABLE IF NOT EXISTS mesh_admission_invitations (
                        token_hash TEXT PRIMARY KEY,
                        creator_user_id TEXT NOT NULL,
                        room_id TEXT NOT NULL,
                        service_url TEXT NOT NULL,
                        via_json TEXT NOT NULL,
                        created_at BIGINT NOT NULL,
                        expires_at BIGINT NOT NULL,
                        signing_key_id TEXT NOT NULL,
                        status TEXT NOT NULL,
                        claim_user_id TEXT,
                        claim_lease_until BIGINT,
                        claimed_at BIGINT
                    )
                        """
                    )
                    columns = {
                        row[1] for row in cursor.execute("PRAGMA table_info(mesh_admission_invitations)")
                    }
                    if "signing_key_id" not in columns:
                        cursor.execute(
                            "ALTER TABLE mesh_admission_invitations ADD COLUMN signing_key_id TEXT"
                        )
                        cursor.execute(
                            "UPDATE mesh_admission_invitations SET signing_key_id = ? WHERE signing_key_id IS NULL",
                            (self.config.signing_key_id,),
                        )
                    cursor.execute(
                        """
                        CREATE TABLE IF NOT EXISTS mesh_admission_openid_proofs (
                        proof_hash TEXT PRIMARY KEY,
                        user_id TEXT NOT NULL,
                        audience TEXT NOT NULL,
                        used_at BIGINT NOT NULL,
                        expires_at BIGINT NOT NULL
                    )
                        """
                    )
                else:
                    # Production schema creation and grants are an operator-owned
                    # migration boundary. The runtime identity must never gain
                    # CREATE authority merely because the service started.
                    cursor.execute("SELECT 1 FROM mesh_admission_invitations LIMIT 0")
                    cursor.execute("SELECT 1 FROM mesh_admission_openid_proofs LIMIT 0")
                connection.commit()
                self._initialized = True
            finally:
                connection.close()

    def healthy(self) -> bool:
        self.initialize()
        connection = self.connect()
        try:
            cursor = connection.cursor()
            cursor.execute("SELECT 1")
            return cursor.fetchone() is not None
        finally:
            connection.close()

    def insert(
        self,
        digest: str,
        creator_user_id: str,
        room_id: str,
        service_url: str,
        via: list[str],
        created_at: int,
        expires_at: int,
        signing_key_id: str = "primary",
    ) -> None:
        self.initialize()
        marker = self.placeholder
        connection = self.connect()
        try:
            cursor = connection.cursor()
            cursor.execute(
                f"""
                INSERT INTO mesh_admission_invitations (
                    token_hash, creator_user_id, room_id, service_url, via_json,
                    created_at, expires_at, signing_key_id, status
                ) VALUES ({marker}, {marker}, {marker}, {marker}, {marker}, {marker}, {marker}, {marker}, {marker})
                """,
                (
                    digest,
                    creator_user_id,
                    room_id,
                    service_url,
                    json.dumps(via, separators=(",", ":")),
                    created_at,
                    expires_at,
                    signing_key_id,
                    "active",
                ),
            )
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def consume_identity_proof(
        self,
        digest: str,
        user_id: str,
        audience: str,
        used_at: int,
        expires_at: int,
    ) -> None:
        """Atomically records a one-use OpenID proof without retaining credentials."""
        self.initialize()
        marker = self.placeholder
        connection = self.connect()
        try:
            cursor = connection.cursor()
            cursor.execute(
                f"""
                DELETE FROM mesh_admission_openid_proofs
                WHERE expires_at <= {marker}
                """,
                (used_at,),
            )
            cursor.execute(
                f"""
                INSERT INTO mesh_admission_openid_proofs (
                    proof_hash, user_id, audience, used_at, expires_at
                ) VALUES ({marker}, {marker}, {marker}, {marker}, {marker})
                """,
                (digest, user_id, audience, used_at, expires_at),
            )
            connection.commit()
        except Exception as error:
            connection.rollback()
            if "unique" in str(error).lower() or "duplicate" in str(error).lower():
                raise AdmissionError(
                    HTTPStatus.CONFLICT,
                    "identity_proof_replayed",
                    "This sign-in proof has already been used. Try again.",
                ) from None
            raise
        finally:
            connection.close()

    def get_active(self, digest: str, now_ms: int) -> dict[str, Any]:
        self.initialize()
        marker = self.placeholder
        connection = self.connect()
        try:
            cursor = connection.cursor()
            cursor.execute(
                f"""
                SELECT creator_user_id, room_id, service_url, via_json,
                       expires_at, signing_key_id, status, claim_user_id, claim_lease_until
                FROM mesh_admission_invitations
                WHERE token_hash = {marker}
                """,
                (digest,),
            )
            row = cursor.fetchone()
            if row is None:
                raise AdmissionError(
                    HTTPStatus.NOT_FOUND,
                    "invitation_invalid",
                    "This invitation is not valid.",
                )
            values = dict(row) if self.sqlite else {
                "creator_user_id": row[0],
                "room_id": row[1],
                "service_url": row[2],
                "via_json": row[3],
                "expires_at": row[4],
                "signing_key_id": row[5],
                "status": row[6],
                "claim_user_id": row[7],
                "claim_lease_until": row[8],
            }
            if int(values["expires_at"]) <= now_ms:
                raise AdmissionError(
                    HTTPStatus.GONE,
                    "invitation_expired",
                    "This invitation has expired.",
                )
            if values["status"] == "claimed":
                raise AdmissionError(
                    HTTPStatus.GONE,
                    "invitation_used",
                    "This invitation has already been used.",
                )
            if (
                values["status"] == "claiming"
                and int(values["claim_lease_until"] or 0) > now_ms
            ):
                raise AdmissionError(
                    HTTPStatus.CONFLICT,
                    "invitation_claiming",
                    "This invitation is already being opened.",
                )
            values["via"] = json.loads(values.pop("via_json"))
            return values
        finally:
            connection.close()

    def begin_claim(self, digest: str, claimant: str, now_ms: int) -> dict[str, Any]:
        self.initialize()
        marker = self.placeholder
        connection = self.connect()
        try:
            cursor = connection.cursor()
            cursor.execute(
                f"""
                UPDATE mesh_admission_invitations
                SET status = {marker}, claim_user_id = {marker}, claim_lease_until = {marker}
                WHERE token_hash = {marker}
                  AND expires_at > {marker}
                  AND (
                    status = {marker}
                    OR (
                      status = {marker}
                      AND COALESCE(claim_lease_until, 0) <= {marker}
                    )
                  )
                """,
                (
                    "claiming",
                    claimant,
                    now_ms + CLAIM_LEASE_SECONDS * 1000,
                    digest,
                    now_ms,
                    "active",
                    "claiming",
                    now_ms,
                ),
            )
            if cursor.rowcount != 1:
                connection.rollback()
                # Resolve the user-facing reason, but never return a row for a
                # lease this caller did not acquire.
                self.get_active(digest, now_ms)
                raise AdmissionError(
                    HTTPStatus.CONFLICT,
                    "invitation_claiming",
                    "This invitation is already being opened.",
                )
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()
        return self.get_claim(digest, claimant)

    def get_claim(self, digest: str, claimant: str) -> dict[str, Any]:
        marker = self.placeholder
        connection = self.connect()
        try:
            cursor = connection.cursor()
            cursor.execute(
                f"""
                SELECT creator_user_id, room_id, service_url, via_json, expires_at
                FROM mesh_admission_invitations
                WHERE token_hash = {marker} AND status = {marker} AND claim_user_id = {marker}
                """,
                (digest, "claiming", claimant),
            )
            row = cursor.fetchone()
            if row is None:
                raise AdmissionError(
                    HTTPStatus.CONFLICT,
                    "invitation_claiming",
                    "This invitation is already being opened.",
                )
            values = dict(row) if self.sqlite else {
                "creator_user_id": row[0],
                "room_id": row[1],
                "service_url": row[2],
                "via_json": row[3],
                "expires_at": row[4],
            }
            values["via"] = json.loads(values.pop("via_json"))
            return values
        finally:
            connection.close()

    def finish_claim(self, digest: str, claimant: str, now_ms: int) -> None:
        self._set_claim_status(digest, claimant, "claimed", now_ms)

    def release_claim(self, digest: str, claimant: str) -> None:
        self._set_claim_status(digest, claimant, "active", None)

    def _set_claim_status(
        self,
        digest: str,
        claimant: str,
        status: str,
        claimed_at: int | None,
    ) -> None:
        marker = self.placeholder
        connection = self.connect()
        try:
            cursor = connection.cursor()
            cursor.execute(
                f"""
                UPDATE mesh_admission_invitations
                SET status = {marker}, claim_user_id = {marker},
                    claim_lease_until = NULL, claimed_at = {marker}
                WHERE token_hash = {marker} AND status = {marker} AND claim_user_id = {marker}
                """,
                (
                    status,
                    claimant if status == "claimed" else None,
                    claimed_at,
                    digest,
                    "claiming",
                    claimant,
                ),
            )
            if cursor.rowcount != 1:
                raise RuntimeError("invitation claim lease was lost")
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()


MatrixRequest = Callable[
    [str, str, dict[str, Any] | None, str | None],
    Any,
]
OpenIdVerifier = Callable[[dict[str, Any]], str]
RegistrationTokenIssuer = Callable[[str, str, int], None]


class AdmissionApplication:
    def __init__(
        self,
        config: Config,
        store: InvitationStore,
        matrix_request: MatrixRequest | None = None,
        openid_verifier: OpenIdVerifier | None = None,
        registration_token_issuer: RegistrationTokenIssuer | None = None,
    ) -> None:
        self.config = config
        self.store = store
        self.matrix_request = matrix_request or self._matrix_request
        self.openid_verifier = openid_verifier or self._unconfigured_openid_verifier
        self.registration_token_issuer = (
            registration_token_issuer or self._unconfigured_registration_token_issuer
        )

    @staticmethod
    def _unconfigured_openid_verifier(_proof: dict[str, Any]) -> str:
        # Matrix's standardized federation userinfo endpoint accepts the proof
        # in a URL query. Mesh's boundary forbids credentials in URLs, so a
        # production deployment must provide a reviewed POST-capable verifier.
        raise AdmissionError(
            HTTPStatus.SERVICE_UNAVAILABLE,
            "identity_verifier_unavailable",
            "This community cannot verify invitation creators yet.",
        )

    @staticmethod
    def _unconfigured_registration_token_issuer(
        action: str,
        _token: str,
        _expires_at: int,
    ) -> None:
        if action == "revoke":
            return
        # Synapse's registration-token management API requires a server-admin
        # account and offers no admission-only scope. Production must inject a
        # reviewed least-privilege issuer instead of elevating this service.
        raise AdmissionError(
            HTTPStatus.SERVICE_UNAVAILABLE,
            "registration_issuer_unavailable",
            "This community cannot issue new-account invitations yet.",
        )

    def verify_service_identity(self) -> None:
        response = self.matrix_request(
            "GET",
            "/_matrix/client/v3/account/whoami",
            None,
            self.config.service_access_token,
        )
        actual_user = str(response.get("user_id", "")) if isinstance(response, dict) else ""
        if actual_user != self.config.service_user_id:
            raise AdmissionError(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "service_identity_invalid",
                "The admission service identity is not configured safely.",
            )

    def _matrix_request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None,
        access_token: str | None,
    ) -> Any:
        headers = {"Accept": "application/json"}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body, separators=(",", ":")).encode("utf-8")
        if access_token:
            headers["Authorization"] = f"Bearer {access_token}"
        request = urllib.request.Request(
            f"{self.config.homeserver_internal_url}{path}",
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                payload = response.read(MAX_MATRIX_RESPONSE_BYTES + 1)
                if len(payload) > MAX_MATRIX_RESPONSE_BYTES:
                    raise AdmissionError(
                        HTTPStatus.BAD_GATEWAY,
                        "service_response_invalid",
                        "The account service returned an invalid response.",
                    )
                return json.loads(payload or b"{}")
        except urllib.error.HTTPError as error:
            # Drain a bounded prefix but never reflect an upstream body. A
            # malicious or misconfigured service could echo credentials from
            # its request into that text.
            error.read(8 * 1024)
            if error.code in (401, 403):
                raise AdmissionError(
                    HTTPStatus.FORBIDDEN,
                    "permission_denied",
                    "The account does not have permission for this invitation.",
                ) from None
            if error.code == 404:
                raise AdmissionError(
                    HTTPStatus.NOT_FOUND,
                    "not_found",
                    "The community could not be found.",
                ) from None
            if error.code == 429:
                raise AdmissionError(
                    HTTPStatus.TOO_MANY_REQUESTS,
                    "rate_limited",
                    "Too many invitation requests. Try again shortly.",
                ) from None
            raise AdmissionError(
                HTTPStatus.BAD_GATEWAY,
                "service_unavailable",
                "The account service could not complete the invitation.",
            ) from None
        except urllib.error.URLError:
            raise AdmissionError(
                HTTPStatus.BAD_GATEWAY,
                "service_unavailable",
                "The account service is temporarily unavailable.",
            ) from None

    def verify_identity_proof(
        self,
        proof: Any,
        expected_purpose: str,
        expected_subject: str,
    ) -> str:
        if not isinstance(proof, dict):
            raise AdmissionError(
                HTTPStatus.BAD_REQUEST,
                "identity_proof_invalid",
                "Sign in again before creating an invitation.",
            )
        proof_id = str(proof.get("proof_id", ""))
        audience = str(proof.get("audience", ""))
        claimed_user = str(proof.get("user_id", ""))
        access_token = str(proof.get("access_token", ""))
        token_type = str(proof.get("token_type", ""))
        server_name = str(proof.get("matrix_server_name", ""))
        purpose = str(proof.get("purpose", ""))
        subject = str(proof.get("subject", ""))
        expires_in = proof.get("expires_in")
        try:
            uuid.UUID(proof_id)
        except (ValueError, AttributeError):
            proof_id = ""
        if (
            not proof_id
            or purpose != expected_purpose
            or subject != expected_subject
            or len(subject) > 512
            or audience != self.config.public_origin
            or not USER_ID_PATTERN.fullmatch(claimed_user)
            or token_type.lower() != "bearer"
            or not access_token
            or len(access_token) > MAX_AUTHORIZATION_BYTES
            or any(character.isspace() for character in access_token)
            or server_name != claimed_user.split(":", 1)[1]
            or isinstance(expires_in, bool)
            or not isinstance(expires_in, int)
            or not 0 < expires_in <= MAX_OPENID_PROOF_SECONDS
        ):
            raise AdmissionError(
                HTTPStatus.BAD_REQUEST,
                "identity_proof_invalid",
                "Sign in again before creating an invitation.",
            )
        verified_user = self.openid_verifier(dict(proof))
        if verified_user != claimed_user:
            raise AdmissionError(
                HTTPStatus.UNAUTHORIZED,
                "identity_proof_mismatch",
                "The signed-in account did not match this invitation request.",
            )
        now_ms = int(time.time() * 1000)
        expires_at = now_ms + expires_in * 1000
        # The one-use identity is the credential itself, not the client-chosen
        # proof envelope. Including proof_id, purpose, subject, or audience in
        # this digest would let the same OpenID token replay under a new UUID or
        # operation. The envelope is still validated above before consumption.
        proof_hash = hmac.new(
            self.config.signing_key,
            (
                "mesh-openid-credential-v1\0"
                + server_name
                + "\0"
                + claimed_user
                + "\0"
                + access_token
            ).encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        self.store.consume_identity_proof(
            proof_hash,
            claimed_user,
            audience,
            now_ms,
            expires_at,
        )
        return claimed_user

    def require_room_administrator(self, user_id: str, room_id: str) -> None:
        encoded_room = urllib.parse.quote(room_id, safe="")
        encoded_user = urllib.parse.quote(user_id, safe="")
        create = self.matrix_request(
            "GET",
            f"/_matrix/client/v3/rooms/{encoded_room}/state/m.room.create",
            None,
            self.config.service_access_token,
        )
        if create.get("type") != "m.space":
            raise AdmissionError(
                HTTPStatus.BAD_REQUEST,
                "community_required",
                "Invitation links can be created only for a community.",
            )
        membership = self.matrix_request(
            "GET",
            f"/_matrix/client/v3/rooms/{encoded_room}/state/m.room.member/{encoded_user}",
            None,
            self.config.service_access_token,
        )
        if membership.get("membership") != "join":
            raise AdmissionError(
                HTTPStatus.FORBIDDEN,
                "permission_denied",
                "Join the community before creating an invitation.",
            )
        power = self.matrix_request(
            "GET",
            f"/_matrix/client/v3/rooms/{encoded_room}/state/m.room.power_levels",
            None,
            self.config.service_access_token,
        )
        users = power.get("users") if isinstance(power.get("users"), dict) else {}
        events = power.get("events") if isinstance(power.get("events"), dict) else {}
        user_level = safe_power_level(users.get(user_id), safe_power_level(power.get("users_default"), 0))
        invite_level = safe_power_level(power.get("invite"), 0)
        state_default = safe_power_level(power.get("state_default"), 50)
        join_rule_level = safe_power_level(events.get("m.room.join_rules"), state_default)
        if user_level < max(50, invite_level, join_rule_level):
            raise AdmissionError(
                HTTPStatus.FORBIDDEN,
                "permission_denied",
                "Only a community administrator can create invitation links.",
            )

    def create_invitation(
        self,
        identity_proof: dict[str, Any],
        room_id: str,
        expires_in_seconds: int = DEFAULT_EXPIRY_SECONDS,
    ) -> dict[str, Any]:
        if not ROOM_ID_PATTERN.fullmatch(room_id):
            raise AdmissionError(
                HTTPStatus.BAD_REQUEST,
                "room_invalid",
                "Choose a valid community.",
            )
        if not MIN_EXPIRY_SECONDS <= expires_in_seconds <= MAX_EXPIRY_SECONDS:
            raise AdmissionError(
                HTTPStatus.BAD_REQUEST,
                "expiry_invalid",
                "Invitation expiry is outside the supported range.",
            )
        creator = self.verify_identity_proof(identity_proof, "create", room_id)
        self.require_room_administrator(creator, room_id)

        admission_token = secrets.token_urlsafe(32)
        registration = registration_token(self.config.signing_key, admission_token)
        now_ms = int(time.time() * 1000)
        expires_at = now_ms + expires_in_seconds * 1000
        self.registration_token_issuer("issue", registration, expires_at)
        try:
            self.store.insert(
                token_digest(admission_token),
                creator,
                room_id,
                self.config.homeserver_public_url,
                [self.config.server_name],
                now_ms,
                expires_at,
                self.config.signing_key_id,
            )
        except Exception:
            try:
                self.registration_token_issuer("revoke", registration, expires_at)
            except Exception:
                pass
            raise

        return {
            # URL fragments are not included in HTTP request targets, proxy
            # logs, referrers, or server access logs.
            "invite_url": f"{self.config.public_origin}/invite#{admission_token}",
            "expires_at": expires_at,
        }

    def resolve_invitation(self, admission_token: str) -> dict[str, Any]:
        validate_admission_token(admission_token)
        values = self.store.get_active(token_digest(admission_token), int(time.time() * 1000))
        return {
            "version": 4,
            "registration_token": registration_token(
                invitation_signing_key(self.config, str(values["signing_key_id"])),
                admission_token,
            ),
            "room_id": values["room_id"],
            "service": values["service_url"],
            "via": values["via"],
            "expires_at": values["expires_at"],
        }

    def claim_invitation(
        self,
        admission_token: str,
        claimant: str,
        identity_proof: dict[str, Any],
    ) -> dict[str, Any]:
        validate_admission_token(admission_token)
        if not USER_ID_PATTERN.fullmatch(claimant):
            raise AdmissionError(
                HTTPStatus.BAD_REQUEST,
                "user_id_invalid",
                "Choose a valid signed-in account.",
            )
        verified_claimant = self.verify_identity_proof(
            identity_proof,
            "claim",
            admission_token,
        )
        if verified_claimant != claimant:
            raise AdmissionError(
                HTTPStatus.UNAUTHORIZED,
                "identity_proof_mismatch",
                "The signed-in account did not match this invitation claim.",
            )
        now_ms = int(time.time() * 1000)
        digest = token_digest(admission_token)
        values = self.store.begin_claim(digest, claimant, now_ms)
        try:
            self.ensure_invited(
                values["room_id"],
                claimant,
                self.config.service_access_token,
            )
            encoded_space = urllib.parse.quote(values["room_id"], safe="")
            state = self.matrix_request(
                "GET",
                f"/_matrix/client/v3/rooms/{encoded_space}/state",
                None,
                self.config.service_access_token,
            )
            if not isinstance(state, list):
                raise AdmissionError(
                    HTTPStatus.BAD_GATEWAY,
                    "service_response_invalid",
                    "The account service returned invalid community rooms.",
                )
            child_rooms: list[str] = []
            for event in state:
                if not isinstance(event, dict) or event.get("type") != "m.space.child":
                    continue
                child_room = str(event.get("state_key", ""))
                if ROOM_ID_PATTERN.fullmatch(child_room) and child_room not in child_rooms:
                    child_rooms.append(child_room)
                if len(child_rooms) > MAX_COMMUNITY_ROOMS:
                    raise AdmissionError(
                        HTTPStatus.BAD_REQUEST,
                        "community_too_large",
                        "This community has too many rooms for one invitation.",
                    )
            for child_room in child_rooms:
                self.ensure_invited(
                    child_room,
                    claimant,
                    self.config.service_access_token,
                )
            self.store.finish_claim(digest, claimant, int(time.time() * 1000))
        except Exception:
            try:
                self.store.release_claim(digest, claimant)
            except Exception:
                pass
            raise
        try:
            self.registration_token_issuer(
                "revoke",
                registration_token(
                    invitation_signing_key(self.config, str(values["signing_key_id"])),
                    admission_token,
                ),
                int(values["expires_at"]),
            )
        except Exception:
            pass
        return {
            "version": 4,
            "room_id": values["room_id"],
            "service": values["service_url"],
            "via": values["via"],
        }

    def ensure_invited(
        self,
        room_id: str,
        claimant: str,
        inviter_token: str,
    ) -> None:
        encoded_room = urllib.parse.quote(room_id, safe="")
        encoded_claimant = urllib.parse.quote(claimant, safe="")
        membership = ""
        try:
            membership_response = self.matrix_request(
                "GET",
                (
                    f"/_matrix/client/v3/rooms/{encoded_room}/state/"
                    f"m.room.member/{encoded_claimant}"
                ),
                None,
                inviter_token,
            )
            if isinstance(membership_response, dict):
                membership = str(membership_response.get("membership", ""))
        except AdmissionError as error:
            if error.code != "not_found":
                raise
        if membership not in {"invite", "join"}:
            self.matrix_request(
                "POST",
                f"/_matrix/client/v3/rooms/{encoded_room}/invite",
                {"user_id": claimant},
                inviter_token,
            )

    def invitation_html(self) -> bytes:
        nonce = secrets.token_urlsafe(18)
        origin = json.dumps(self.config.public_origin)
        return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-{nonce}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>Open Mesh invitation</title>
  <style>
    body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111318; color: #f5f7fb; font: 16px system-ui, sans-serif; }}
    main {{ width: min(32rem, calc(100% - 3rem)); padding: 2rem; border: 1px solid #303642; border-radius: 1rem; background: #1a1e26; text-align: center; }}
    .actions {{ display: flex; flex-wrap: wrap; justify-content: center; gap: .75rem; margin-top: 1.25rem; }}
    a {{ display: inline-block; padding: .8rem 1.2rem; border-radius: .6rem; background: #7c6cff; color: white; font-weight: 700; text-decoration: none; }}
    a.secondary {{ border: 1px solid #596273; background: transparent; }}
    p {{ color: #bdc5d6; line-height: 1.6; }}
  </style>
</head>
<body>
  <main>
    <h1>Join this community in Mesh</h1>
    <p id="status">Mesh will verify this private invitation when you choose Open Mesh.</p>
    <p>If Mesh is not installed yet, get it first and keep this page open. Then come back here to join.</p>
    <div class="actions">
      <a id="open" hidden>Open Mesh</a>
      <a class="secondary" href="https://mesh.dhawal.org/download/" target="_blank" rel="noopener noreferrer">Get Mesh</a>
    </div>
  </main>
  <script nonce="{nonce}">
    (() => {{
      const capability = window.location.hash.slice(1);
      const status = document.getElementById("status");
      const open = document.getElementById("open");
      if (!/^[A-Za-z0-9_-]{{32,64}}$/.test(capability)) {{
        status.textContent = "This invitation is incomplete. Ask for a new invitation link.";
        return;
      }}
      const target = new URL("mesh://join");
      target.searchParams.set("v", "4");
      target.searchParams.set("kind", "managed");
      target.searchParams.set("api", {origin});
      target.searchParams.set("code", capability);
      open.href = target.href;
      open.hidden = false;
    }})();
  </script>
</body>
</html>
""".encode("utf-8")


def safe_power_level(value: Any, default: int) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int) and -2**53 < value < 2**53:
        return value
    return default


def validate_admission_token(value: str) -> None:
    if not ADMISSION_TOKEN_PATTERN.fullmatch(value):
        raise AdmissionError(
            HTTPStatus.NOT_FOUND,
            "invitation_invalid",
            "This invitation is not valid.",
        )


class RateLimiter:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.entries: dict[tuple[str, str], list[float]] = {}

    def require(self, key: str, bucket: str, limit: int, window_seconds: int = 60) -> None:
        now = time.monotonic()
        cutoff = now - window_seconds
        identity = (key, bucket)
        with self.lock:
            recent = [timestamp for timestamp in self.entries.get(identity, []) if timestamp > cutoff]
            if len(recent) >= limit:
                self.entries[identity] = recent
                raise AdmissionError(
                    HTTPStatus.TOO_MANY_REQUESTS,
                    "rate_limited",
                    "Too many invitation requests. Try again shortly.",
                )
            recent.append(now)
            self.entries[identity] = recent
            if len(self.entries) > 10_000:
                self.entries = {
                    entry_key: timestamps
                    for entry_key, timestamps in self.entries.items()
                    if any(timestamp > cutoff for timestamp in timestamps)
                }


class AdmissionHandler(BaseHTTPRequestHandler):
    server_version = "MeshAdmission/1"
    sys_version = ""
    application: AdmissionApplication
    limiter = RateLimiter()

    def log_message(self, _format: str, *_args: Any) -> None:
        # Keep request logging disabled even though invitation capabilities are
        # now fragment-only and therefore never reach this server.
        return

    def do_GET(self) -> None:  # noqa: N802
        try:
            path = urllib.parse.urlparse(self.path)
            if path.query or path.fragment:
                raise AdmissionError(HTTPStatus.NOT_FOUND, "not_found", "Not found.")
            if path.path == "/healthz":
                if not self.application.store.healthy():
                    raise AdmissionError(
                        HTTPStatus.SERVICE_UNAVAILABLE,
                        "unhealthy",
                        "The invitation service is not ready.",
                    )
                self.send_json(HTTPStatus.OK, {"status": "ok"})
                return
            if path.path == "/invite":
                self.limiter.require(self.client_key(), "html", 60)
                payload = self.application.invitation_html()
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Referrer-Policy", "no-referrer")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            raise AdmissionError(HTTPStatus.NOT_FOUND, "not_found", "Not found.")
        except AdmissionError as error:
            self.send_error_json(error)
        except Exception:
            self.send_error_json(
                AdmissionError(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    "internal_error",
                    "The invitation service could not complete the request.",
                )
            )

    def do_POST(self) -> None:  # noqa: N802
        try:
            path = urllib.parse.urlparse(self.path)
            if path.query or path.fragment:
                raise AdmissionError(HTTPStatus.NOT_FOUND, "not_found", "Not found.")
            if path.path == "/_mesh/admission/v1/invitations/create":
                self.limiter.require(self.client_key(), "create", 20)
                self.reject_authorization()
                body = self.read_json_body()
                room_id = str(body.get("room_id", ""))
                identity_proof = body.get("identity_proof")
                expires = body.get("expires_in_seconds", DEFAULT_EXPIRY_SECONDS)
                if isinstance(expires, bool) or not isinstance(expires, int):
                    raise AdmissionError(
                        HTTPStatus.BAD_REQUEST,
                        "expiry_invalid",
                        "Invitation expiry is invalid.",
                    )
                self.send_json(
                    HTTPStatus.CREATED,
                    self.application.create_invitation(identity_proof, room_id, expires),
                )
                return
            if path.path == "/_mesh/admission/v1/invitations/resolve":
                self.limiter.require(self.client_key(), "resolve", 60)
                self.reject_authorization()
                body = self.read_json_body()
                self.send_json(
                    HTTPStatus.OK,
                    self.application.resolve_invitation(str(body.get("invitation", ""))),
                )
                return
            if path.path == "/_mesh/admission/v1/invitations/claim":
                self.limiter.require(self.client_key(), "claim", 20)
                self.reject_authorization()
                body = self.read_json_body()
                claimant = str(body.get("user_id", ""))
                self.send_json(
                    HTTPStatus.OK,
                    self.application.claim_invitation(
                        str(body.get("invitation", "")),
                        claimant,
                        body.get("identity_proof"),
                    ),
                )
                return
            raise AdmissionError(HTTPStatus.NOT_FOUND, "not_found", "Not found.")
        except AdmissionError as error:
            self.send_error_json(error)
        except Exception:
            self.send_error_json(
                AdmissionError(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    "internal_error",
                    "The invitation service could not complete the request.",
                )
            )

    def client_key(self) -> str:
        forwarded = self.headers.get("X-Forwarded-For", "")
        if forwarded:
            candidate = forwarded.split(",", 1)[0].strip()
            try:
                return str(ipaddress.ip_address(candidate))
            except ValueError:
                pass
        return self.client_address[0]

    def reject_authorization(self) -> None:
        if self.headers.get("Authorization") is not None:
            raise AdmissionError(
                HTTPStatus.BAD_REQUEST,
                "client_credential_rejected",
                "This service does not accept account access credentials.",
            )

    def read_json_body(self, require_empty: bool = False) -> dict[str, Any]:
        content_length = self.headers.get("Content-Length")
        if content_length is None:
            raise AdmissionError(
                HTTPStatus.LENGTH_REQUIRED,
                "body_required",
                "A request body is required.",
            )
        try:
            length = int(content_length)
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY_BYTES:
            raise AdmissionError(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                "body_too_large",
                "The request body is too large.",
            )
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise AdmissionError(
                HTTPStatus.BAD_REQUEST,
                "json_invalid",
                "The request body is not valid JSON.",
            ) from None
        if not isinstance(body, dict) or (require_empty and body):
            raise AdmissionError(
                HTTPStatus.BAD_REQUEST,
                "body_invalid",
                "The request body is invalid.",
            )
        return body

    def send_json(self, status: HTTPStatus, body: dict[str, Any]) -> None:
        payload = json.dumps(body, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def send_error_json(self, error: AdmissionError) -> None:
        self.send_json(
            error.status,
            {"code": error.code, "message": error.message},
        )


def main() -> None:
    config = Config.from_environment()
    store = InvitationStore(config)
    store.initialize()
    application = AdmissionApplication(config, store)
    application.verify_service_identity()
    AdmissionHandler.application = application
    server = ThreadingHTTPServer((config.bind_host, config.bind_port), AdmissionHandler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
