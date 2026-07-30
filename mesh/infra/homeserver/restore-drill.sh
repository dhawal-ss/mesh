#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$script_dir"
umask 077
# shellcheck source=infra/homeserver/backup-lib.sh
. "$script_dir/backup-lib.sh"

postgres_image="postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193"
synapse_image="matrixdotorg/synapse:v1.157.0@sha256:53a686c52cdfca5fdb0adff5ef10b276b1d0971931b09815a9eb6b48d7188a1a"

if [ "$#" -gt 1 ]; then
  echo "usage: $0 [/path/to/backup]" >&2
  exit 2
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required for the isolated restore drill." >&2
  exit 1
fi

if [ "$#" -eq 1 ]; then
  backup_dir="${1%/}"
else
  backup_dir=""
  for candidate in "$script_dir"/runtime/backups/20??????T??????Z; do
    if [ -d "$candidate" ]; then
      backup_dir="$candidate"
    fi
  done
  if [ -z "$backup_dir" ]; then
    echo "No local backup is available for a restore drill." >&2
    exit 1
  fi
fi
sh "$script_dir/verify-backup.sh" "$backup_dir" >&2

read_setting() {
  awk -F= -v key="$1" \
    '$1 == key { sub(/^[^=]*=/, ""); print; exit }' \
    "$backup_dir/backup-metadata.env"
}

server_name="$(read_setting MESH_SERVER_NAME)"
postgres_user="$(read_setting POSTGRES_USER)"
postgres_db="$(read_setting POSTGRES_DB)"
postgres_password="${MESH_RESTORE_POSTGRES_PASSWORD:-}"
if [ -z "$postgres_password" ]; then
  echo "MESH_RESTORE_POSTGRES_PASSWORD must be supplied from the external operator secret store; the backup does not contain the standalone operator environment." >&2
  exit 1
fi
case "$server_name" in
  *[!A-Za-z0-9.-]*|"")
    echo "Backup contains an invalid server name." >&2
    exit 1
    ;;
esac
for postgres_identity in "$postgres_user" "$postgres_db"; do
  if ! printf '%s' "$postgres_identity" |
     grep -Eq '^[A-Za-z_][A-Za-z0-9_]*$'
  then
    echo "Backup contains an invalid PostgreSQL identity." >&2
    exit 1
  fi
done

drill_root="$script_dir/runtime/restore-drills"
mkdir -p "$drill_root" "$script_dir/runtime/status"
stage="$(mktemp -d "$drill_root/.work.XXXXXX")"
runtime_uid="${MESH_RESTORE_RUNTIME_UID:-$(id -u)}"
runtime_gid="${MESH_RESTORE_RUNTIME_GID:-$(id -g)}"
case "$runtime_uid:$runtime_gid" in
  *[!0-9:]*|:*|*:)
    echo "Restore runtime UID and GID must be numeric." >&2
    exit 1
    ;;
esac
resource_suffix="$(date -u +%Y%m%d%H%M%S)-$$"
network="mesh-restore-$resource_suffix"
volume="mesh-restore-$resource_suffix"
postgres_container="mesh-restore-postgres-$resource_suffix"
synapse_container="mesh-restore-synapse-$resource_suffix"

cleanup() {
  docker rm -f "$synapse_container" "$postgres_container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  if [ "${MESH_KEEP_RESTORE_DRILL:-0}" != "1" ]; then
    rm -rf -- "$stage"
  else
    echo "Preserved restore drill files for inspection: $stage" >&2
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir "$stage/synapse"
tar -xzf "$backup_dir/synapse-critical.tar.gz" -C "$stage/synapse"
if [ -f "$backup_dir/media-store.tar.gz" ]; then
  tar -xzf "$backup_dir/media-store.tar.gz" -C "$stage/synapse"
fi
if [ "$(id -u)" -eq 0 ]; then
  chown -R "$runtime_uid:$runtime_gid" "$stage/synapse"
elif [ "$runtime_uid" -ne "$(id -u)" ] || [ "$runtime_gid" -ne "$(id -g)" ]; then
  echo "A non-root drill must use the current host UID and GID." >&2
  exit 1
fi

docker network create "$network" >/dev/null
docker volume create "$volume" >/dev/null
docker run -d \
  --name "$postgres_container" \
  --network "$network" \
  --network-alias postgres \
  --security-opt no-new-privileges:true \
  -e "POSTGRES_USER=$postgres_user" \
  -e "POSTGRES_DB=$postgres_db" \
  -e "POSTGRES_PASSWORD=$postgres_password" \
  -e "POSTGRES_INITDB_ARGS=--encoding=UTF8 --locale=C" \
  -v "$volume:/var/lib/postgresql/data" \
  "$postgres_image" >/dev/null

attempt=0
until docker exec "$postgres_container" \
  pg_isready --username "$postgres_user" --dbname "$postgres_db" >/dev/null 2>&1
do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "Restored PostgreSQL did not become ready within 120 seconds." >&2
    exit 1
  fi
  sleep 2
done

dump_listing="$(docker exec -i "$postgres_container" pg_restore --list < "$backup_dir/postgres.dump")"
printf '%s\n' "$dump_listing" | assert_no_otk_table_data

docker exec -i "$postgres_container" \
  pg_restore \
    --username "$postgres_user" \
    --dbname "$postgres_db" \
    --exit-on-error \
    --no-owner \
    --no-privileges \
  < "$backup_dir/postgres.dump"

required_tables="$(
  docker exec "$postgres_container" \
    psql \
      --username "$postgres_user" \
      --dbname "$postgres_db" \
      --tuples-only \
      --no-align \
      --command \
      "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('users', 'rooms', 'events');"
)"
required_tables="$(printf '%s' "$required_tables" | tr -d '[:space:]')"
if [ "$required_tables" -ne 3 ]; then
  echo "Restored database is missing required Synapse tables." >&2
  exit 1
fi
otk_rows="$(
  docker exec "$postgres_container" \
    psql \
      --username "$postgres_user" \
      --dbname "$postgres_db" \
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

docker run -d \
  --name "$synapse_container" \
  --network "$network" \
  --security-opt no-new-privileges:true \
  -e "UID=$runtime_uid" \
  -e "GID=$runtime_gid" \
  -e SYNAPSE_CONFIG_PATH=/data/homeserver.yaml \
  -v "$stage/synapse:/data" \
  "$synapse_image" >/dev/null

attempt=0
until docker exec "$synapse_container" python -c \
  "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8008/health', timeout=3).read()" \
  >/dev/null 2>&1
do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 90 ]; then
    echo "Restored Synapse did not become healthy within 180 seconds." >&2
    docker logs --tail 50 "$synapse_container" >&2 || true
    exit 1
  fi
  sleep 2
done
docker exec "$synapse_container" python -c \
  "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8008/_matrix/client/versions', timeout=5).read()" \
  >/dev/null

completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
backup_id="$(basename "$backup_dir")"
status_tmp="$script_dir/runtime/status/.restore-drill-status.$$"
printf '%s\n' \
  "{\"status\":\"ok\",\"lastSuccessfulAt\":\"$completed_at\",\"backupId\":\"$backup_id\",\"serverName\":\"$server_name\"}" \
  > "$status_tmp"
chmod 600 "$status_tmp"
mv "$status_tmp" "$script_dir/runtime/status/restore-drill-status.json"

echo "Restore drill passed: database restored and isolated Synapse became healthy."
