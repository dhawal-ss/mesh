#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$script_dir"
umask 077

usage() {
  echo "Usage: $0 --stage | --activate ROTATION_ID | --rollback ROTATION_ID | --revoke-previous ROTATION_ID" >&2
  exit 2
}

require_env_file() {
  [ -f .env ] || { echo "Missing .env. Run ./setup.sh first." >&2; exit 1; }
}

env_value() {
  sed -n "s/^$2=//p" "$1" | tail -n 1
}

validate_rotation_id() {
  case "$1" in
    *[!A-Za-z0-9_-]*|'') echo "Invalid rotation ID." >&2; exit 1 ;;
  esac
}

set_role_passwords() {
  env_file="$1"
  postgres_user="$(env_value "$env_file" POSTGRES_USER)"
  postgres_db="$(env_value "$env_file" POSTGRES_DB)"
  postgres_password="$(env_value "$env_file" POSTGRES_PASSWORD)"
  admission_password="$(env_value "$env_file" MESH_ADMISSION_DB_PASSWORD)"
  for setting in "$postgres_user" "$postgres_db" "$postgres_password" "$admission_password"; do
    case "$setting" in
      *[!A-Za-z0-9_.:-]*|'')
        echo "Rotation environment contains invalid database settings." >&2
        exit 1
        ;;
    esac
  done
  docker compose exec -T postgres psql \
    --username "$(env_value .env POSTGRES_USER)" \
    --dbname "$(env_value .env POSTGRES_DB)" \
    --set ON_ERROR_STOP=1 \
    --set role_name="$postgres_user" \
    --set postgres_password="$postgres_password" \
    --set admission_password="$admission_password" <<'SQL' >/dev/null
BEGIN;
SELECT format('ALTER ROLE %I PASSWORD %L', :'role_name', :'postgres_password')
\gexec
SELECT format('ALTER ROLE mesh_admission PASSWORD %L', :'admission_password')
\gexec
COMMIT;
SQL
}

revoke_admission_service_token() {
  env_file="$1"
  service_token="$(env_value "$env_file" MESH_ADMISSION_SERVICE_ACCESS_TOKEN)"
  case "$service_token" in
    ""|REPLACE_*)
      echo "Rotation source does not contain a valid admission service token." >&2
      return 1
      ;;
  esac
  printf '%s' "$service_token" |
    docker compose exec -T synapse python -c '
import sys
import urllib.request

token = sys.stdin.read()
request = urllib.request.Request(
    "http://127.0.0.1:8008/_matrix/client/v3/logout",
    data=b"{}",
    headers={
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
    },
    method="POST",
)
with urllib.request.urlopen(request, timeout=10) as response:
    if response.status != 200:
        raise SystemExit(1)
' >/dev/null
  unset service_token
}

write_evidence() {
  rotation_id="$1"
  phase="$2"
  previous_key_id="$3"
  active_key_id="$4"
  old_invites="$5"
  evidence_dir="$script_dir/rotation-evidence/$rotation_id"
  mkdir -p "$evidence_dir"
  source_sha="$(git -C "$script_dir/../../.." rev-parse HEAD 2>/dev/null || printf unknown)"
  collected_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  evidence_file="$evidence_dir/$phase.json"
  cat > "$evidence_file" <<EOF
{"schemaVersion":1,"rotationId":"$rotation_id","phase":"$phase","sourceCommit":"$source_sha","collectedAt":"$collected_at","previousSigningKeyId":"$previous_key_id","activeSigningKeyId":"$active_key_id","activePreviousKeyInvitations":$old_invites}
EOF
  chmod 0444 "$evidence_file"
}

active_previous_invites() {
  previous_key_id="$1"
  if [ -z "$previous_key_id" ]; then
    printf 0
    return
  fi
  docker compose exec -T postgres psql \
    --username "$(env_value .env POSTGRES_USER)" \
    --dbname "$(env_value .env POSTGRES_DB)" \
    --tuples-only --no-align --set ON_ERROR_STOP=1 \
    --set previous_key_id="$previous_key_id" \
    --command "SELECT count(*) FROM mesh_admission.mesh_admission_invitations WHERE signing_key_id = :'previous_key_id' AND status IN ('active','claiming') AND expires_at > (extract(epoch from clock_timestamp()) * 1000)::bigint;" \
    | tr -d '[:space:]'
}

stage_rotation() {
  require_env_file
  [ ! -e .env.rotation.pending ] || { echo "A staged rotation already exists." >&2; exit 1; }
  ./provision-admission-database.sh >/dev/null
  rotation_id="$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4)"
  rollback_file="$script_dir/.env.rotation.$rotation_id.rollback"
  pending_file="$script_dir/.env.rotation.pending"
  old_key="$(env_value .env MESH_ADMISSION_SIGNING_KEY)"
  old_key_id="$(env_value .env MESH_ADMISSION_SIGNING_KEY_ID)"
  old_previous="$(env_value .env MESH_ADMISSION_PREVIOUS_SIGNING_KEYS)"
  [ -z "$old_previous" ] || {
    echo "A previous admission signing-key overlap is still active; revoke it before staging another rotation." >&2
    exit 1
  }
  cp .env "$rollback_file"
  chmod 0600 "$rollback_file"

  new_key="$(openssl rand -hex 32)"
  new_key_id="$(printf '%s' "$new_key" | sha256sum | cut -c1-16)"
  previous_keys="$old_key_id:$old_key"
  [ -z "$old_previous" ] || previous_keys="$previous_keys,$old_previous"

  awk \
    -v postgres="$(openssl rand -hex 32)" \
    -v admission_db="$(openssl rand -hex 32)" \
    -v registration="$(openssl rand -hex 32)" \
    -v macaroon="$(openssl rand -hex 32)" \
    -v form="$(openssl rand -hex 32)" \
    -v signing="$new_key" \
    -v signing_id="$new_key_id" \
    -v previous="$previous_keys" '
      /^POSTGRES_PASSWORD=/ { print "POSTGRES_PASSWORD=" postgres; next }
      /^MESH_ADMISSION_DB_PASSWORD=/ { print "MESH_ADMISSION_DB_PASSWORD=" admission_db; next }
      /^REGISTRATION_SHARED_SECRET=/ { print "REGISTRATION_SHARED_SECRET=" registration; next }
      /^MACAROON_SECRET_KEY=/ { print "MACAROON_SECRET_KEY=" macaroon; next }
      /^FORM_SECRET=/ { print "FORM_SECRET=" form; next }
      /^MESH_ADMISSION_SIGNING_KEY=/ { print "MESH_ADMISSION_SIGNING_KEY=" signing; next }
      /^MESH_ADMISSION_SIGNING_KEY_ID=/ { print "MESH_ADMISSION_SIGNING_KEY_ID=" signing_id; next }
      /^MESH_ADMISSION_PREVIOUS_SIGNING_KEYS=/ { print "MESH_ADMISSION_PREVIOUS_SIGNING_KEYS=" previous; next }
      /^MESH_ADMISSION_SERVICE_ACCESS_TOKEN=/ { print "MESH_ADMISSION_SERVICE_ACCESS_TOKEN=REPLACE_DURING_ROTATION"; next }
      { print }
    ' .env > "$pending_file"
  chmod 0600 "$pending_file"
  old_invites="$(active_previous_invites "$old_key_id")"
  write_evidence "$rotation_id" staged "$old_key_id" "$new_key_id" "$old_invites"
  printf '%s\n' "$rotation_id" > .env.rotation.pending.id
  chmod 0600 .env.rotation.pending.id
  echo "Staged rotation $rotation_id. Review redacted evidence, then run --activate $rotation_id with MESH_SECRET_ROTATION_CONFIRM=ACTIVATE:$rotation_id."
}

activate_rotation() {
  rotation_id="$1"
  validate_rotation_id "$rotation_id"
  [ "${MESH_SECRET_ROTATION_CONFIRM:-}" = "ACTIVATE:$rotation_id" ] || { echo "Activation confirmation is missing." >&2; exit 1; }
  [ "$(cat .env.rotation.pending.id 2>/dev/null || true)" = "$rotation_id" ] || { echo "Staged rotation ID does not match." >&2; exit 1; }
  rollback_file="$script_dir/.env.rotation.$rotation_id.rollback"
  if [ ! -f "$rollback_file" ] || [ ! -f .env.rotation.pending ]; then
    echo "Rotation files are incomplete." >&2
    exit 1
  fi
  old_key_id="$(env_value "$rollback_file" MESH_ADMISSION_SIGNING_KEY_ID)"
  new_key_id="$(env_value .env.rotation.pending MESH_ADMISSION_SIGNING_KEY_ID)"
  rollback_on_error() {
    activation_status=$?
    trap - EXIT HUP INT TERM
    set +e
    rollback_failed=0
    set_role_passwords "$rollback_file" || rollback_failed=1
    cp "$rollback_file" .env || rollback_failed=1
    chmod 0600 .env || rollback_failed=1
    ./setup.sh >/dev/null 2>&1 || rollback_failed=1
    ./start.sh >/dev/null 2>&1 || rollback_failed=1
    ./operational-health.sh >/dev/null 2>&1 || rollback_failed=1
    if [ "$rollback_failed" -ne 0 ]; then
      echo "Secret rotation failed and automatic rollback also needs operator recovery. Protected rotation files were retained." >&2
    else
      echo "Secret rotation failed; prior database roles, environment, and services were restored." >&2
    fi
    exit "$activation_status"
  }
  trap rollback_on_error EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  set_role_passwords .env.rotation.pending
  mv .env.rotation.pending .env
  chmod 0600 .env
  ./setup.sh >/dev/null
  ./start.sh >/dev/null
  ./operational-health.sh >/dev/null
  old_service_token="$(env_value "$rollback_file" MESH_ADMISSION_SERVICE_ACCESS_TOKEN)"
  new_service_token="$(env_value .env MESH_ADMISSION_SERVICE_ACCESS_TOKEN)"
  case "$new_service_token" in
    ""|REPLACE_*)
      echo "Admission service did not receive a replacement access token." >&2
      exit 1
      ;;
  esac
  if [ "$new_service_token" = "$old_service_token" ]; then
    echo "Admission service access token was not rotated." >&2
    exit 1
  fi
  unset old_service_token new_service_token
  revoke_admission_service_token "$rollback_file"
  ./operational-health.sh >/dev/null
  old_invites="$(active_previous_invites "$old_key_id")"
  write_evidence "$rotation_id" activated "$old_key_id" "$new_key_id" "$old_invites"
  rm -f .env.rotation.pending.id
  trap - INT TERM HUP EXIT
  echo "Activated rotation $rotation_id with previous signing-key overlap. Keep the rollback file until explicit revocation."
}

rollback_rotation() {
  rotation_id="$1"
  validate_rotation_id "$rotation_id"
  [ "${MESH_SECRET_ROTATION_CONFIRM:-}" = "ROLLBACK:$rotation_id" ] || { echo "Rollback confirmation is missing." >&2; exit 1; }
  rollback_file="$script_dir/.env.rotation.$rotation_id.rollback"
  [ -f "$rollback_file" ] || { echo "Rollback material is unavailable." >&2; exit 1; }
  failed_file="$script_dir/.env.rotation.$rotation_id.failed"
  cp .env "$failed_file"
  chmod 0600 "$failed_file"
  failed_key="$(env_value "$failed_file" MESH_ADMISSION_SIGNING_KEY)"
  failed_key_id="$(env_value "$failed_file" MESH_ADMISSION_SIGNING_KEY_ID)"
  rollback_target="$(mktemp "$script_dir/.env.rollback-target.XXXXXX")"
  awk -v previous="$failed_key_id:$failed_key" '
    /^MESH_ADMISSION_PREVIOUS_SIGNING_KEYS=/ {
      print "MESH_ADMISSION_PREVIOUS_SIGNING_KEYS=" previous
      next
    }
    { print }
  ' "$rollback_file" > "$rollback_target"
  chmod 0600 "$rollback_target"
  restore_failed_rotation() {
    rollback_status=$?
    trap - EXIT HUP INT TERM
    set +e
    restore_failed=0
    set_role_passwords "$failed_file" || restore_failed=1
    cp "$failed_file" .env || restore_failed=1
    chmod 0600 .env || restore_failed=1
    ./setup.sh >/dev/null 2>&1 || restore_failed=1
    ./start.sh >/dev/null 2>&1 || restore_failed=1
    ./operational-health.sh >/dev/null 2>&1 || restore_failed=1
    if [ "$restore_failed" -ne 0 ]; then
      echo "Rollback failed and the activated environment also needs operator recovery. Protected rotation files were retained." >&2
    else
      echo "Rollback failed; the activated environment was restored." >&2
    fi
    rm -f "$rollback_target"
    exit "$rollback_status"
  }
  trap restore_failed_rotation EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  set_role_passwords "$rollback_target"
  cp "$rollback_target" .env
  chmod 0600 .env
  ./setup.sh >/dev/null
  ./start.sh >/dev/null
  ./operational-health.sh >/dev/null
  old_invites="$(active_previous_invites "$failed_key_id")"
  write_evidence "$rotation_id" rolled-back \
    "$failed_key_id" \
    "$(env_value .env MESH_ADMISSION_SIGNING_KEY_ID)" "$old_invites"
  trap - EXIT HUP INT TERM
  rm -f "$rollback_target"
  unset failed_key failed_key_id
  echo "Rolled back rotation $rotation_id with reverse signing-key overlap. New secret material remains in the protected .failed file for incident review."
}

revoke_previous() {
  rotation_id="$1"
  validate_rotation_id "$rotation_id"
  [ "${MESH_SECRET_ROTATION_CONFIRM:-}" = "REVOKE:$rotation_id" ] || { echo "Revocation confirmation is missing." >&2; exit 1; }
  previous="$(env_value .env MESH_ADMISSION_PREVIOUS_SIGNING_KEYS)"
  [ -n "$previous" ] || { echo "No previous signing key is active." >&2; exit 1; }
  previous_key_id="${previous%%:*}"
  outstanding="$(active_previous_invites "$previous_key_id")"
  [ "$outstanding" = 0 ] || { echo "$outstanding active invitation(s) still require the previous signing key." >&2; exit 1; }
  next_env="$(mktemp "$script_dir/.env.revoke.XXXXXX")"
  revoke_rollback="$(mktemp "$script_dir/.env.revoke-rollback.XXXXXX")"
  cp .env "$revoke_rollback"
  chmod 0600 "$revoke_rollback"
  awk '/^MESH_ADMISSION_PREVIOUS_SIGNING_KEYS=/ { print "MESH_ADMISSION_PREVIOUS_SIGNING_KEYS="; next } { print }' .env > "$next_env"
  chmod 0600 "$next_env"
  restore_revoked_overlap() {
    revoke_status=$?
    trap - EXIT HUP INT TERM
    set +e
    restore_failed=0
    cp "$revoke_rollback" .env || restore_failed=1
    chmod 0600 .env || restore_failed=1
    docker compose up -d --force-recreate admission >/dev/null 2>&1 || restore_failed=1
    ./operational-health.sh >/dev/null 2>&1 || restore_failed=1
    if [ "$restore_failed" -ne 0 ]; then
      echo "Previous-key revocation failed and overlap restoration also needs operator recovery." >&2
    else
      echo "Previous-key revocation failed; the overlap environment was restored." >&2
    fi
    rm -f "$next_env" "$revoke_rollback"
    exit "$revoke_status"
  }
  trap restore_revoked_overlap EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  mv "$next_env" .env
  docker compose up -d --force-recreate admission >/dev/null
  ./operational-health.sh >/dev/null
  write_evidence "$rotation_id" revoked "$previous_key_id" \
    "$(env_value .env MESH_ADMISSION_SIGNING_KEY_ID)" 0
  rm -f "$script_dir/.env.rotation.$rotation_id.rollback"
  trap - EXIT HUP INT TERM
  rm -f "$revoke_rollback"
  echo "Explicitly revoked previous signing-key overlap for rotation $rotation_id."
}

case "${1:-}" in
  --stage) [ "$#" -eq 1 ] || usage; stage_rotation ;;
  --activate) [ "$#" -eq 2 ] || usage; activate_rotation "$2" ;;
  --rollback) [ "$#" -eq 2 ] || usage; rollback_rotation "$2" ;;
  --revoke-previous) [ "$#" -eq 2 ] || usage; revoke_previous "$2" ;;
  *) usage ;;
esac
