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

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
destination="$script_dir/runtime/backups/$timestamp"
mkdir -p "$destination"

docker compose exec -T postgres \
  pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --format=custom \
  > "$destination/postgres.dump"

tar -czf "$destination/synapse-critical.tar.gz" \
  -C "$script_dir/runtime/synapse" \
  homeserver.yaml \
  "$MESH_SERVER_NAME.signing.key" \
  "$MESH_SERVER_NAME.log.config"

if [ -d "$script_dir/runtime/synapse/media_store" ]; then
  tar -czf "$destination/media-store.tar.gz" \
    -C "$script_dir/runtime/synapse" \
    media_store
fi

test -s "$destination/postgres.dump"
echo "Backup completed: $destination"
