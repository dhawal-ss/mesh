#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$script_dir"

if [ ! -f .env ]; then
  echo "Missing .env. Run ./setup.sh first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${MESH_ADMISSION_DB_PASSWORD:?MESH_ADMISSION_DB_PASSWORD is required}"
: "${MESH_ADMISSION_SIGNING_KEY_ID:?MESH_ADMISSION_SIGNING_KEY_ID is required}"

case "$POSTGRES_USER" in
  *[!A-Za-z0-9_]*|'')
    echo "POSTGRES_USER must be a simple PostgreSQL identifier." >&2
    exit 1
    ;;
esac
case "$POSTGRES_DB" in
  *[!A-Za-z0-9_]*|'')
    echo "POSTGRES_DB must be a simple PostgreSQL identifier." >&2
    exit 1
    ;;
esac

# The no-login owner is the only identity that can migrate this schema. The
# network-facing runtime role receives only DML on the two admission tables.
docker compose exec -T postgres \
  psql \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" \
    --set ON_ERROR_STOP=1 \
    --set admission_password="$MESH_ADMISSION_DB_PASSWORD" \
    --set database_name="$POSTGRES_DB" \
    --set synapse_user="$POSTGRES_USER" \
    --set admission_signing_key_id="$MESH_ADMISSION_SIGNING_KEY_ID" <<'SQL'
SELECT 'CREATE ROLE mesh_admission_owner NOLOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mesh_admission_owner')
\gexec

SELECT format('CREATE ROLE mesh_admission LOGIN PASSWORD %L', :'admission_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mesh_admission')
\gexec
SELECT format('ALTER ROLE mesh_admission LOGIN PASSWORD %L', :'admission_password')
\gexec

SELECT format('REVOKE CREATE ON DATABASE %I FROM PUBLIC', :'database_name')
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO mesh_admission', :'database_name')
\gexec
CREATE SCHEMA IF NOT EXISTS mesh_admission AUTHORIZATION mesh_admission_owner;
ALTER SCHEMA mesh_admission OWNER TO mesh_admission_owner;
REVOKE ALL ON SCHEMA mesh_admission FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'synapse_user')
\gexec
GRANT USAGE ON SCHEMA mesh_admission TO mesh_admission;
SELECT format(
  'ALTER ROLE mesh_admission IN DATABASE %I SET search_path TO mesh_admission, pg_catalog',
  :'database_name'
)
\gexec

CREATE TABLE IF NOT EXISTS mesh_admission.mesh_admission_invitations (
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
);
ALTER TABLE mesh_admission.mesh_admission_invitations
  ADD COLUMN IF NOT EXISTS signing_key_id TEXT;
UPDATE mesh_admission.mesh_admission_invitations
SET signing_key_id = :'admission_signing_key_id'
WHERE signing_key_id IS NULL;
ALTER TABLE mesh_admission.mesh_admission_invitations
  ALTER COLUMN signing_key_id SET NOT NULL;
CREATE TABLE IF NOT EXISTS mesh_admission.mesh_admission_openid_proofs (
  proof_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  audience TEXT NOT NULL,
  used_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
ALTER TABLE mesh_admission.mesh_admission_invitations OWNER TO mesh_admission_owner;
ALTER TABLE mesh_admission.mesh_admission_openid_proofs OWNER TO mesh_admission_owner;
REVOKE ALL ON ALL TABLES IN SCHEMA mesh_admission FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA mesh_admission FROM mesh_admission;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON mesh_admission.mesh_admission_invitations,
     mesh_admission.mesh_admission_openid_proofs
  TO mesh_admission;
ALTER DEFAULT PRIVILEGES FOR ROLE mesh_admission_owner IN SCHEMA mesh_admission
  REVOKE ALL ON TABLES FROM PUBLIC;
SQL

runtime_psql() {
  docker compose exec -T postgres \
    psql \
      --username mesh_admission \
      --dbname "$POSTGRES_DB" \
      --set ON_ERROR_STOP=1 \
      --tuples-only \
      --no-align \
      "$@"
}

runtime_psql --command \
  "SELECT 1 FROM mesh_admission_invitations LIMIT 0; SELECT 1 FROM mesh_admission_openid_proofs LIMIT 0;" \
  >/dev/null

if runtime_psql --command "SELECT 1 FROM public.users LIMIT 0;" >/dev/null 2>&1; then
  echo "Admission runtime role can read Synapse tables." >&2
  exit 1
fi
if runtime_psql --command \
  "CREATE TABLE mesh_admission.mesh_admission_privilege_probe (value INTEGER);" \
  >/dev/null 2>&1
then
  runtime_psql --command \
    "DROP TABLE mesh_admission.mesh_admission_privilege_probe;" >/dev/null 2>&1 || true
  echo "Admission runtime role can create tables." >&2
  exit 1
fi

granted_tables="$(
  runtime_psql --command \
    "SELECT table_name FROM information_schema.role_table_grants WHERE grantee = 'mesh_admission' GROUP BY table_name ORDER BY table_name;"
)"
expected_tables="$(printf '%s\n' mesh_admission_invitations mesh_admission_openid_proofs)"
if [ "$granted_tables" != "$expected_tables" ]; then
  echo "Admission runtime role has an unexpected table grant set." >&2
  exit 1
fi

echo "Admission database isolation verified."
