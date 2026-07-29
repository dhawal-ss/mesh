#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$script_dir"
umask 077

synapse_image="matrixdotorg/synapse:v1.157.0@sha256:53a686c52cdfca5fdb0adff5ef10b276b1d0971931b09815a9eb6b48d7188a1a"

mkdir -p \
  runtime/backups \
  runtime/caddy/config \
  runtime/caddy/data \
  runtime/logs \
  runtime/postgres \
  runtime/synapse

if [ ! -f .env ]; then
  postgres_password="$(openssl rand -hex 32)"
  registration_secret="$(openssl rand -hex 32)"
  macaroon_secret="$(openssl rand -hex 32)"
  form_secret="$(openssl rand -hex 32)"

  {
    printf '%s\n' \
      'MESH_SERVER_NAME=mesh.dhawal.org' \
      'MESH_HOMESERVER_HOST=matrix.mesh.dhawal.org' \
      'MESH_RTC_HOST=rtc.mesh.dhawal.org' \
      'MESH_PUBLIC_ENABLED=0' \
      'SYNAPSE_CONTROL_BIND=127.0.0.1' \
      'SYNAPSE_CACHE_FACTOR=0.25' \
      'POSTGRES_USER=synapse' \
      'POSTGRES_DB=synapse'
    printf 'POSTGRES_PASSWORD=%s\n' "$postgres_password"
    printf 'REGISTRATION_SHARED_SECRET=%s\n' "$registration_secret"
    printf 'MACAROON_SECRET_KEY=%s\n' "$macaroon_secret"
    printf 'FORM_SECRET=%s\n' "$form_secret"
    printf 'ACME_EMAIL=%s\n' 'admin@dhawal.org'
  } > .env
  chmod 600 .env
  echo "Created untracked operator secrets in $script_dir/.env"
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${MESH_SERVER_NAME:?MESH_SERVER_NAME is required}"
: "${MESH_HOMESERVER_HOST:?MESH_HOMESERVER_HOST is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${REGISTRATION_SHARED_SECRET:?REGISTRATION_SHARED_SECRET is required}"
: "${MACAROON_SECRET_KEY:?MACAROON_SECRET_KEY is required}"
: "${FORM_SECRET:?FORM_SECRET is required}"

if [ ! -f runtime/synapse/homeserver.yaml ]; then
  docker run --rm \
    -e "SYNAPSE_SERVER_NAME=$MESH_SERVER_NAME" \
    -e SYNAPSE_REPORT_STATS=no \
    -e "UID=$(id -u)" \
    -e "GID=$(id -g)" \
    -v "$script_dir/runtime/synapse:/data" \
    "$synapse_image" generate
fi

docker run --rm \
  --entrypoint python \
  -e MESH_SERVER_NAME \
  -e MESH_HOMESERVER_HOST \
  -e POSTGRES_USER \
  -e POSTGRES_DB \
  -e POSTGRES_PASSWORD \
  -e REGISTRATION_SHARED_SECRET \
  -e MACAROON_SECRET_KEY \
  -e FORM_SECRET \
  -v "$script_dir/runtime/synapse:/data" \
  -v "$script_dir/configure_synapse.py:/configure_synapse.py:ro" \
  "$synapse_image" \
  /configure_synapse.py /data/homeserver.yaml

docker compose config --quiet
echo "Homeserver configuration is ready."
