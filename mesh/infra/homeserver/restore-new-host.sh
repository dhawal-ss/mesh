#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$script_dir"
umask 077
# shellcheck source=infra/homeserver/backup-lib.sh
. "$script_dir/backup-lib.sh"

if [ "$#" -ne 1 ]; then
  echo "usage: $0 /path/to/verified-backup" >&2
  exit 2
fi

if [ "${MESH_CONFIRM_FEDERATED_RESTORE:-}" != "I_UNDERSTAND_DATABASE_ROLLBACK_IS_DESTRUCTIVE" ]; then
  echo "Refusing a live restore without MESH_CONFIRM_FEDERATED_RESTORE=I_UNDERSTAND_DATABASE_ROLLBACK_IS_DESTRUCTIVE." >&2
  echo "Rolling a federated homeserver database backwards can invalidate newer events and must be an explicit owner decision." >&2
  exit 1
fi
recovery_env="${MESH_RECOVERY_OPERATOR_ENV:-}"
if [ -z "$recovery_env" ] || [ ! -f "$recovery_env" ] || [ -L "$recovery_env" ]; then
  echo "Provide MESH_RECOVERY_OPERATOR_ENV pointing to an external, mode-600 operator environment file; backups do not contain the standalone operator environment." >&2
  exit 1
fi
recovery_mode="$(
  stat -f '%Lp' "$recovery_env" 2>/dev/null ||
    stat -c '%a' "$recovery_env" 2>/dev/null ||
    true
)"
if [ "$recovery_mode" != "600" ]; then
  echo "MESH_RECOVERY_OPERATOR_ENV must have mode 600; found ${recovery_mode:-unknown}." >&2
  exit 1
fi

backup_dir="${1%/}"
sh "$script_dir/verify-backup.sh" "$backup_dir" >&2

read_environment_setting() {
  setting_file="$1"
  setting_key="$2"
  setting_count="$(
    awk -F= -v key="$setting_key" \
      '$1 == key { count += 1 } END { print count + 0 }' \
      "$setting_file"
  )"
  if [ "$setting_count" -ne 1 ]; then
    echo "$setting_file must contain exactly one $setting_key setting." >&2
    return 1
  fi
  awk -F= -v key="$setting_key" \
    '$1 == key { sub(/^[^=]*=/, ""); print; exit }' \
    "$setting_file"
}

for identity_key in MESH_SERVER_NAME POSTGRES_USER POSTGRES_DB; do
  backup_value="$(
    read_environment_setting "$backup_dir/backup-metadata.env" "$identity_key"
  )"
  recovery_value="$(
    read_environment_setting "$recovery_env" "$identity_key"
  )"
  if [ "$backup_value" != "$recovery_value" ]; then
    echo "Recovery environment $identity_key does not match the verified backup." >&2
    exit 1
  fi
done

# This command is intentionally valid only in a clean deployment checkout. It
# never overwrites or merges a running service.
for protected_path in \
  "$script_dir/.env" \
  "$script_dir/runtime/postgres" \
  "$script_dir/runtime/synapse"
do
  if [ -e "$protected_path" ] || [ -L "$protected_path" ]; then
    echo "Refusing recovery because target state already exists: $protected_path" >&2
    exit 1
  fi
done

mkdir -p \
  "$script_dir/runtime/backups" \
  "$script_dir/runtime/caddy/config" \
  "$script_dir/runtime/caddy/data" \
  "$script_dir/runtime/logs" \
  "$script_dir/runtime/postgres" \
  "$script_dir/runtime/status" \
  "$script_dir/runtime/synapse"

cp "$recovery_env" "$script_dir/.env"
chmod 600 "$script_dir/.env"

# Public traffic and calling remain disabled until the recovered service has
# passed local verification and the operator deliberately cuts traffic over.
next_env="$(mktemp "$script_dir/.env.recovery.XXXXXX")"
awk '
  /^MESH_PUBLIC_ENABLED=/ { print "MESH_PUBLIC_ENABLED=0"; next }
  /^MESH_RTC_ENABLED=/ { print "MESH_RTC_ENABLED=0"; next }
  { print }
' "$script_dir/.env" > "$next_env"
chmod 600 "$next_env"
mv "$next_env" "$script_dir/.env"

tar -xzf "$backup_dir/synapse-critical.tar.gz" \
  -C "$script_dir/runtime/synapse"
if [ -f "$backup_dir/media-store.tar.gz" ]; then
  tar -xzf "$backup_dir/media-store.tar.gz" \
    -C "$script_dir/runtime/synapse"
fi

# Rolling a federated homeserver database backwards is destructive. Never do
# this casually. The stable signing key must be restored intact; never
# regenerate it. If a signing key is retired, preserve its public key in
# old_signing_keys before changing identity, rather than silently replacing it.
# Rebuild generated discovery and proxy state without replacing the restored
# signing key, media, or Synapse configuration.
"$script_dir/setup.sh"

set -a
# shellcheck disable=SC1091
. "$script_dir/.env"
set +a
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"

docker compose up -d postgres
attempt=0
until docker compose exec -T postgres \
  pg_isready --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" >/dev/null 2>&1
do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "Recovered PostgreSQL did not become ready within 120 seconds." >&2
    exit 1
  fi
  sleep 2
done

dump_listing="$(docker compose exec -T postgres pg_restore --list < "$backup_dir/postgres.dump")"
printf '%s\n' "$dump_listing" | assert_no_otk_table_data

docker compose exec -T postgres \
  pg_restore \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" \
    --exit-on-error \
    --no-owner \
    --no-privileges \
  < "$backup_dir/postgres.dump"

otk_rows="$(
  docker compose exec -T postgres \
    psql \
      --username "$POSTGRES_USER" \
      --dbname "$POSTGRES_DB" \
      --tuples-only \
      --no-align \
      --command \
      "SELECT count(*) FROM e2e_one_time_keys_json;"
)"
otk_rows="$(printf '%s' "$otk_rows" | tr -d '[:space:]')"
if [ "$otk_rows" -ne 0 ]; then
  echo "Restored database contains $otk_rows e2e_one_time_keys_json rows." >&2
  exit 1
fi

docker compose up -d synapse
deadline=$(( $(date +%s) + 180 ))
until curl --fail --silent http://127.0.0.1:8008/health >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "Recovered Synapse did not become healthy within 180 seconds." >&2
    docker compose logs --tail 50 synapse >&2 || true
    exit 1
  fi
  sleep 2
done
curl --fail --silent \
  http://127.0.0.1:8008/_matrix/client/versions >/dev/null

completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
backup_id="$(basename "$backup_dir")"
status_tmp="$script_dir/runtime/status/.new-host-restore-status.$$"
printf '%s\n' \
  "{\"status\":\"ok\",\"lastSuccessfulAt\":\"$completed_at\",\"backupId\":\"$backup_id\"}" \
  > "$status_tmp"
chmod 600 "$status_tmp"
mv "$status_tmp" "$script_dir/runtime/status/new-host-restore-status.json"

echo "New-host restore passed locally. Public traffic and calling remain disabled."
