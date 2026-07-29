#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$script_dir"
umask 077

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

docker compose exec -T postgres \
  pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --format=custom \
  > "$staging/postgres.dump"
test -s "$staging/postgres.dump"
docker compose exec -T postgres pg_restore --list \
  < "$staging/postgres.dump" >/dev/null

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

# A complete disaster recovery needs the stable server identity and the
# matching runtime secrets. The local backup directory is mode 0700 and the
# offsite path is required to use restic's authenticated encryption.
cp .env "$staging/operator.env"
chmod 600 "$staging/operator.env"

{
  for backup_file in \
    operator.env \
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

completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
status_tmp="$status_root/.local-backup-status.$$"
printf '%s\n' \
  "{\"status\":\"ok\",\"lastSuccessfulAt\":\"$completed_at\",\"backupId\":\"$timestamp\"}" \
  > "$status_tmp"
chmod 600 "$status_tmp"
mv "$status_tmp" "$status_root/local-backup-status.json"

echo "Backup completed and verified: $destination" >&2
printf '%s\n' "$destination"
