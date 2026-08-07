#!/bin/sh
set -eu

if [ "${MESH_RUN_RESTORE_INTEGRATION:-0}" != "1" ]; then
  echo "Set MESH_RUN_RESTORE_INTEGRATION=1 to run the disposable Docker restore test." >&2
  exit 2
fi

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
homeserver_dir="$(CDPATH= cd -- "$script_dir/.." && pwd)"
# shellcheck source=infra/homeserver/docker-cli.sh
. "$homeserver_dir/docker-cli.sh"
postgres_image="postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193"
synapse_image="matrixdotorg/synapse:v1.157.2@sha256:097e3120b8ecf97e4f92537d7af2da41564c706e33fc740f3741c9defacc2af1"

iteration="${MESH_RESTORE_DRILL_ITERATION:-standalone}"
case "$iteration" in
  standalone|1|2) ;;
  *)
    echo "MESH_RESTORE_DRILL_ITERATION must be 1, 2, or unset." >&2
    exit 2
    ;;
esac
test_root="$(mktemp -d)"
test_root_docker="$(mesh_docker_bind_path "$test_root")"
homeserver_dir_docker="$(mesh_docker_bind_path "$homeserver_dir")"
restore_runtime="$test_root/restore-runtime"
resource_suffix="mesh-source-$iteration-$$"
network="$resource_suffix"
volume="$resource_suffix"
postgres_container="$resource_suffix-postgres"
synapse_container="$resource_suffix-synapse"

stream_synapse_archive() {
  destination="$1"
  shift

  # Synapse deliberately owns /data as UID 991. Read the recovery files as
  # that identity inside the running container, but let the invoking shell
  # create the archive so operators can read and move the resulting backup.
  if ! mesh_docker exec --user 991:991 "$synapse_container" \
    tar -czf - -C /data "$@" > "$destination"
  then
    rm -f -- "$destination"
    echo "Could not stream Synapse recovery data into $destination." >&2
    return 1
  fi
}

assert_host_owned_readable_file() {
  recovery_file="$1"

  if [ ! -f "$recovery_file" ] || [ ! -s "$recovery_file" ] || [ ! -r "$recovery_file" ]; then
    echo "Recovery artifact is not a non-empty host-readable file: $recovery_file" >&2
    return 1
  fi

  host_uid="$(id -u)"
  file_uid="$(stat -c '%u' "$recovery_file" 2>/dev/null || stat -f '%u' "$recovery_file" 2>/dev/null || true)"
  if [ -n "$file_uid" ] && [ "$file_uid" != "$host_uid" ]; then
    echo "Recovery artifact is owned by UID $file_uid instead of invoking host UID $host_uid: $recovery_file" >&2
    return 1
  fi
}

cleanup() {
  original_status=$?
  trap - EXIT HUP INT TERM
  set +e
  cleanup_status=0

  mesh_docker rm -f "$synapse_container" "$postgres_container" >/dev/null 2>&1 || :
  mesh_docker volume rm "$volume" >/dev/null 2>&1 || :
  mesh_docker network rm "$network" >/dev/null 2>&1 || :

  # Synapse deliberately runs as UID 991. Return disposable bind-mount files
  # to the invoking host identity before removal so a useful failure is not
  # hidden by a second permission-denied cleanup error.
  if [ -d "$test_root" ] && mesh_docker image inspect "$synapse_image" >/dev/null 2>&1; then
    # Expansion must happen inside the container.
    # shellcheck disable=SC2016
    mesh_docker run --rm \
      --entrypoint sh \
      --user 0:0 \
      -e "MESH_CLEANUP_UID=$(id -u)" \
      -e "MESH_CLEANUP_GID=$(id -g)" \
      -v "$test_root_docker:/mesh-restore-cleanup" \
      "$synapse_image" \
      -c 'chown -R "$MESH_CLEANUP_UID:$MESH_CLEANUP_GID" /mesh-restore-cleanup' \
      >/dev/null 2>&1 || cleanup_status=1
  fi
  rm -rf -- "${test_root:?}" || cleanup_status=1

  if [ "$original_status" -ne 0 ]; then
    if [ "$cleanup_status" -ne 0 ]; then
      echo "Restore integration failed with exit code $original_status; disposable cleanup also failed." >&2
    else
      echo "Restore integration failed with exit code $original_status; disposable cleanup completed." >&2
    fi
    exit "$original_status"
  fi
  if [ "$cleanup_status" -ne 0 ]; then
    echo "Restore integration passed, but disposable cleanup failed." >&2
    exit "$cleanup_status"
  fi
  exit 0
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
abuse_email="${MESH_ABUSE_EMAIL:-abuse@mesh.restore.test}"

mkdir -p "$test_root/synapse" "$test_root/backup"
mesh_docker pull "$postgres_image" >/dev/null
mesh_docker pull "$synapse_image" >/dev/null

mesh_docker run --rm \
  -e "SYNAPSE_SERVER_NAME=$server_name" \
  -e SYNAPSE_REPORT_STATS=no \
  -e UID=991 \
  -e GID=991 \
  -v "$test_root_docker/synapse:/data" \
  "$synapse_image" generate >/dev/null

# The generated configuration and all subsequent Synapse state are owned by
# the image's documented runtime identity. This makes the test independent of
# the hosted runner's umask and bind-mount ownership defaults.
mesh_docker run --rm \
  --entrypoint sh \
  --user 0:0 \
  -v "$test_root_docker/synapse:/data" \
  "$synapse_image" \
  -c 'chown -R 991:991 /data && chmod -R u+rwX /data'

mesh_docker run --rm \
  --entrypoint python \
  --user 991:991 \
  -e "MESH_SERVER_NAME=$server_name" \
  -e MESH_HOMESERVER_HOST=matrix.mesh.restore.test \
  -e "MESH_ABUSE_EMAIL=$abuse_email" \
  -e "POSTGRES_USER=$postgres_user" \
  -e "POSTGRES_DB=$postgres_db" \
  -e "POSTGRES_PASSWORD=$postgres_password" \
  -e "REGISTRATION_SHARED_SECRET=$registration_secret" \
  -e "MACAROON_SECRET_KEY=$macaroon_secret" \
  -e "FORM_SECRET=$form_secret" \
  -v "$test_root_docker/synapse:/data" \
  -v "$homeserver_dir_docker/configure_synapse.py:/configure_synapse.py:ro" \
  "$synapse_image" \
  /configure_synapse.py /data/homeserver.yaml

mesh_docker network create "$network" >/dev/null
mesh_docker volume create "$volume" >/dev/null
mesh_docker run -d \
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
until mesh_docker exec "$postgres_container" \
  pg_isready --username "$postgres_user" --dbname "$postgres_db" >/dev/null 2>&1
do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "Source PostgreSQL did not become ready." >&2
    exit 1
  fi
  sleep 2
done

mesh_docker run -d \
  --name "$synapse_container" \
  --network "$network" \
  -e UID=991 \
  -e GID=991 \
  -e SYNAPSE_CONFIG_PATH=/data/homeserver.yaml \
  -v "$test_root_docker/synapse:/data" \
  "$synapse_image" >/dev/null

attempt=0
until mesh_docker exec "$synapse_container" python -c \
  "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8008/health', timeout=3).read()" \
  >/dev/null 2>&1
do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 90 ]; then
    echo "Source Synapse did not become healthy." >&2
    mesh_docker logs --tail 50 "$synapse_container" >&2 || true
    exit 1
  fi
  sleep 2
done

mesh_docker exec "$synapse_container" register_new_matrix_user \
  -c /data/homeserver.yaml \
  http://127.0.0.1:8008 \
  -u restore-test \
  -p restore-test-account-password \
  -a >/dev/null

mesh_docker exec "$postgres_container" \
  pg_dump \
    --username "$postgres_user" \
    --dbname "$postgres_db" \
    --format=custom \
    --exclude-table-data e2e_one_time_keys_json \
  > "$test_root/backup/postgres.dump"
stream_synapse_archive \
  "$test_root/backup/synapse-critical.tar.gz" \
  homeserver.yaml \
  "$server_name.signing.key" \
  "$server_name.log.config"
if mesh_docker exec --user 991:991 "$synapse_container" test -d /data/media_store; then
  stream_synapse_archive \
    "$test_root/backup/media-store.tar.gz" \
    media_store
fi

assert_host_owned_readable_file "$test_root/backup/postgres.dump"
assert_host_owned_readable_file "$test_root/backup/synapse-critical.tar.gz"
tar -tzf "$test_root/backup/synapse-critical.tar.gz" >/dev/null
if [ -f "$test_root/backup/media-store.tar.gz" ]; then
  assert_host_owned_readable_file "$test_root/backup/media-store.tar.gz"
  tar -tzf "$test_root/backup/media-store.tar.gz" >/dev/null
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
if MESH_RESTORE_DRILL_RUNTIME_ROOT="$restore_runtime" \
  MESH_RESTORE_POSTGRES_PASSWORD="$postgres_password" \
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
MESH_RESTORE_DRILL_RUNTIME_ROOT="$restore_runtime" \
MESH_RESTORE_POSTGRES_PASSWORD="$postgres_password" \
  sh "$homeserver_dir/restore-drill.sh" "$test_root/backup"
test -s "$restore_runtime/status/restore-drill-status.json"

echo "Disposable PostgreSQL and Synapse restore integration test passed (iteration $iteration)."
