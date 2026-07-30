#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$script_dir"
umask 077
# shellcheck source=infra/homeserver/backup-lib.sh
. "$script_dir/backup-lib.sh"

if [ ! -f .env ]; then
  echo "Missing .env. Run ./setup.sh first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${MESH_SERVER_NAME:?MESH_SERVER_NAME is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"

local_keep_daily="${MESH_LOCAL_BACKUP_KEEP_DAILY:-7}"
local_keep_weekly="${MESH_LOCAL_BACKUP_KEEP_WEEKLY:-4}"
for value in "$local_keep_daily" "$local_keep_weekly"; do
  case "$value" in
    *[!0-9]*|"")
      echo "MESH_LOCAL_BACKUP_KEEP_DAILY and MESH_LOCAL_BACKUP_KEEP_WEEKLY must be non-negative integers." >&2
      exit 1
      ;;
  esac
done

backup_root="$script_dir/runtime/backups"
status_root="$script_dir/runtime/status"
lock_dir="$backup_root/.backup.lock"
staging=""

mkdir -p "$backup_root" "$status_root"
if ! mkdir "$lock_dir" 2>/dev/null; then
  echo "Another homeserver backup is already running: $lock_dir" >&2
  exit 1
fi

cleanup() {
  if [ -n "$staging" ] && [ -d "$staging" ]; then
    rm -rf -- "$staging"
  fi
  rmdir "$lock_dir" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    echo "A SHA-256 utility (sha256sum or shasum) is required." >&2
    exit 1
  fi
}

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
destination="$backup_root/$timestamp"
if [ -e "$destination" ]; then
  echo "A backup with this timestamp already exists: $destination" >&2
  exit 1
fi
staging="$backup_root/.$timestamp.partial.$$"
mkdir "$staging"

for required_file in \
  "runtime/synapse/homeserver.yaml" \
  "runtime/synapse/$MESH_SERVER_NAME.signing.key" \
  "runtime/synapse/$MESH_SERVER_NAME.log.config"
do
  if [ ! -f "$required_file" ] || [ -L "$required_file" ]; then
    echo "Required homeserver file is missing or unsafe: $required_file" >&2
    exit 1
  fi
done

# Synapse backup guidance requires excluding already-used one-time keys. If
# restored, e2e_one_time_keys_json rows can be re-issued and break federation
# decryption. See https://element-hq.github.io/synapse/latest/usage/administration/howto-maintenance-and-tasks.html#database-backups.
docker compose exec -T postgres \
  pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --format=custom \
  --exclude-table-data e2e_one_time_keys_json \
  > "$staging/postgres.dump"
test -s "$staging/postgres.dump"
dump_listing="$(docker compose exec -T postgres pg_restore --list < "$staging/postgres.dump")"
printf '%s\n' "$dump_listing" | assert_no_otk_table_data

tar -czf "$staging/synapse-critical.tar.gz" \
  -C "$script_dir/runtime/synapse" \
  homeserver.yaml \
  "$MESH_SERVER_NAME.signing.key" \
  "$MESH_SERVER_NAME.log.config"

if [ -d "$script_dir/runtime/synapse/media_store" ]; then
  tar -czf "$staging/media-store.tar.gz" \
    -C "$script_dir/runtime/synapse" \
    media_store
fi

# The standalone operator environment and admission credentials intentionally
# do not enter the backup set. The Synapse configuration and stable signing
# key remain sensitive, so local FileVault and encrypted offsite storage are
# still required.
{
  printf 'MESH_SERVER_NAME=%s\n' "$MESH_SERVER_NAME"
  printf 'POSTGRES_USER=%s\n' "$POSTGRES_USER"
  printf 'POSTGRES_DB=%s\n' "$POSTGRES_DB"
} > "$staging/backup-metadata.env"
chmod 600 "$staging/backup-metadata.env"

{
  for backup_file in \
    backup-metadata.env \
    postgres.dump \
    synapse-critical.tar.gz \
    media-store.tar.gz
  do
    if [ -f "$staging/$backup_file" ]; then
      printf '%s  %s\n' \
        "$(sha256_file "$staging/$backup_file")" \
        "$backup_file"
    fi
  done
} > "$staging/manifest.sha256"
chmod 600 "$staging/manifest.sha256"

sh "$script_dir/verify-backup.sh" "$staging" >&2
mv "$staging" "$destination"
staging=""
chmod 700 "$destination"
prune_local_backups \
  "$backup_root" \
  "$destination" \
  "$local_keep_daily" \
  "$local_keep_weekly"

completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
status_tmp="$status_root/.local-backup-status.$$"
printf '%s\n' \
  "{\"status\":\"ok\",\"lastSuccessfulAt\":\"$completed_at\",\"backupId\":\"$timestamp\"}" \
  > "$status_tmp"
chmod 600 "$status_tmp"
mv "$status_tmp" "$status_root/local-backup-status.json"

echo "Backup completed and verified: $destination" >&2
printf '%s\n' "$destination"
