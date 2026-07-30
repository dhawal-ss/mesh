#!/bin/sh
set -eu

if [ "${MESH_RUN_RESTORE_INTEGRATION:-0}" != "1" ]; then
  echo "Set MESH_RUN_RESTORE_INTEGRATION=1 to run the disposable Docker restore test." >&2
  exit 2
fi

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
homeserver_dir="$(CDPATH= cd -- "$script_dir/.." && pwd)"
postgres_image="postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193"
synapse_image="matrixdotorg/synapse:v1.157.0@sha256:53a686c52cdfca5fdb0adff5ef10b276b1d0971931b09815a9eb6b48d7188a1a"

test_root="$(mktemp -d)"
resource_suffix="mesh-source-$$"
network="$resource_suffix"
volume="$resource_suffix"
postgres_container="$resource_suffix-postgres"
synapse_container="$resource_suffix-synapse"

cleanup() {
  docker rm -f "$synapse_container" "$postgres_container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf -- "${test_root:?}"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

server_name="mesh.restore.test"
postgres_user="synapse"
postgres_db="synapse"
postgres_password="restore-test-postgres-password"
registration_secret="restore-test-registration-secret"
macaroon_secret="restore-test-macaroon-secret"
form_secret="restore-test-form-secret"

mkdir -p "$test_root/synapse" "$test_root/backup"
docker pull "$postgres_image" >/dev/null
docker pull "$synapse_image" >/dev/null

docker run --rm \
  -e "SYNAPSE_SERVER_NAME=$server_name" \
  -e SYNAPSE_REPORT_STATS=no \
  -e UID=991 \
  -e GID=991 \
  -v "$test_root/synapse:/data" \
  "$synapse_image" generate >/dev/null

docker run --rm \
  --entrypoint python \
  --user 991:991 \
  -e "MESH_SERVER_NAME=$server_name" \
  -e MESH_HOMESERVER_HOST=matrix.mesh.restore.test \
  -e "POSTGRES_USER=$postgres_user" \
  -e "POSTGRES_DB=$postgres_db" \
  -e "POSTGRES_PASSWORD=$postgres_password" \
  -e "REGISTRATION_SHARED_SECRET=$registration_secret" \
  -e "MACAROON_SECRET_KEY=$macaroon_secret" \
  -e "FORM_SECRET=$form_secret" \
  -v "$test_root/synapse:/data" \
  -v "$homeserver_dir/configure_synapse.py:/configure_synapse.py:ro" \
  "$synapse_image" \
  /configure_synapse.py /data/homeserver.yaml

docker network create "$network" >/dev/null
docker volume create "$volume" >/dev/null
docker run -d \
  --name "$postgres_container" \
  --network "$network" \
  --network-alias postgres \
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
    echo "Source PostgreSQL did not become ready." >&2
    exit 1
  fi
  sleep 2
done

docker run -d \
  --name "$synapse_container" \
  --network "$network" \
  -e UID=991 \
  -e GID=991 \
  -e SYNAPSE_CONFIG_PATH=/data/homeserver.yaml \
  -v "$test_root/synapse:/data" \
  "$synapse_image" >/dev/null

attempt=0
until docker exec "$synapse_container" python -c \
  "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8008/health', timeout=3).read()" \
  >/dev/null 2>&1
do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 90 ]; then
    echo "Source Synapse did not become healthy." >&2
    docker logs --tail 50 "$synapse_container" >&2 || true
    exit 1
  fi
  sleep 2
done

docker exec "$synapse_container" register_new_matrix_user \
  -c /data/homeserver.yaml \
  http://127.0.0.1:8008 \
  -u restore-test \
  -p restore-test-account-password \
  -a >/dev/null

docker exec "$postgres_container" \
  pg_dump \
    --username "$postgres_user" \
    --dbname "$postgres_db" \
    --format=custom \
    --exclude-table-data e2e_one_time_keys_json \
  > "$test_root/backup/postgres.dump"
tar -czf "$test_root/backup/synapse-critical.tar.gz" \
  -C "$test_root/synapse" \
  homeserver.yaml \
  "$server_name.signing.key" \
  "$server_name.log.config"
if [ -d "$test_root/synapse/media_store" ]; then
  tar -czf "$test_root/backup/media-store.tar.gz" \
    -C "$test_root/synapse" \
    media_store
fi

cat > "$test_root/backup/backup-metadata.env" <<EOF
MESH_SERVER_NAME=$server_name
POSTGRES_USER=$postgres_user
POSTGRES_DB=$postgres_db
EOF
{
  for file in \
    backup-metadata.env \
    postgres.dump \
    synapse-critical.tar.gz \
    media-store.tar.gz
  do
    if [ -f "$test_root/backup/$file" ]; then
      printf '%s  %s\n' \
        "$(sha256sum "$test_root/backup/$file" | awk '{ print $1 }')" \
        "$file"
    fi
  done
} > "$test_root/backup/manifest.sha256"

sh "$homeserver_dir/verify-backup.sh" "$test_root/backup" >/dev/null
cp "$test_root/backup/manifest.sha256" "$test_root/backup/manifest.valid"
printf 'tampered manifest entry\n' >> "$test_root/backup/manifest.sha256"
if MESH_RESTORE_POSTGRES_PASSWORD="$postgres_password" \
  sh "$homeserver_dir/restore-drill.sh" "$test_root/backup" \
  > "$test_root/tampered-restore.log" 2>&1
then
  echo "restore-drill accepted a tampered manifest." >&2
  exit 1
fi
if ! grep -qi 'manifest' "$test_root/tampered-restore.log"; then
  echo "restore-drill did not explain the tampered manifest failure." >&2
  exit 1
fi
mv "$test_root/backup/manifest.valid" "$test_root/backup/manifest.sha256"
MESH_RESTORE_RUNTIME_UID=991 \
MESH_RESTORE_RUNTIME_GID=991 \
MESH_RESTORE_POSTGRES_PASSWORD="$postgres_password" \
  sh "$homeserver_dir/restore-drill.sh" "$test_root/backup"
test -s "$homeserver_dir/runtime/status/restore-drill-status.json"

echo "Disposable PostgreSQL and Synapse restore integration test passed."
