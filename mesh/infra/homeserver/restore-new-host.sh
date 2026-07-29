#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$script_dir"
umask 077

if [ "$#" -ne 1 ]; then
  echo "usage: $0 /path/to/verified-backup" >&2
  exit 2
fi

backup_dir="${1%/}"
sh "$script_dir/verify-backup.sh" "$backup_dir" >&2

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

cp "$backup_dir/operator.env" "$script_dir/.env"
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

docker compose exec -T postgres \
  pg_restore \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" \
    --exit-on-error \
    --no-owner \
    --no-privileges \
  < "$backup_dir/postgres.dump"

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
