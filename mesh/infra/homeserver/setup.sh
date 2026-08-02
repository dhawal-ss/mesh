#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$script_dir"
umask 077

synapse_image="matrixdotorg/synapse:v1.157.1@sha256:d1fce43d7501428c461f2758dc10342555b946dc9f1d03c1b1b8aec1a4e8d130"

mkdir -p \
  runtime/backups \
  runtime/caddy/config \
  runtime/caddy/data \
  runtime/logs \
  runtime/postgres \
  runtime/synapse

if [ ! -f .env ]; then
  : "${MESH_SERVER_NAME:?Set the permanent community Matrix server name before first setup}"
  : "${MESH_HOMESERVER_HOST:?Set the public homeserver host before first setup}"
  : "${MESH_ABUSE_EMAIL:?Set the community abuse contact before first setup}"
  : "${ACME_EMAIL:?Set the ACME contact before first setup}"
  mesh_rtc_host="${MESH_RTC_HOST:-rtc.$MESH_SERVER_NAME}"
  postgres_password="$(openssl rand -hex 32)"
  registration_secret="$(openssl rand -hex 32)"
  macaroon_secret="$(openssl rand -hex 32)"
  form_secret="$(openssl rand -hex 32)"
  admission_signing_key="$(openssl rand -hex 32)"

  {
    printf '%s\n' \
      "MESH_SERVER_NAME=$MESH_SERVER_NAME" \
      "MESH_HOMESERVER_HOST=$MESH_HOMESERVER_HOST" \
      "MESH_RTC_HOST=$mesh_rtc_host" \
      'MESH_RTC_ENABLED=0' \
      'MESH_PUBLIC_ENABLED=0' \
      'MESH_REGISTRATION_ENABLED=1' \
      "MESH_ABUSE_EMAIL=$MESH_ABUSE_EMAIL" \
      'MESH_OPERATOR_LOCALPART=operator' \
      "MESH_RUNTIME_UID=$(id -u)" \
      "MESH_RUNTIME_GID=$(id -g)" \
      'SYNAPSE_CONTROL_BIND=127.0.0.1' \
      'SYNAPSE_CACHE_FACTOR=0.25' \
      'POSTGRES_USER=synapse' \
      'POSTGRES_DB=synapse'
    printf 'POSTGRES_PASSWORD=%s\n' "$postgres_password"
    printf 'MESH_ADMISSION_DB_PASSWORD=%s\n' "$(openssl rand -hex 32)"
    printf 'REGISTRATION_SHARED_SECRET=%s\n' "$registration_secret"
    printf 'MACAROON_SECRET_KEY=%s\n' "$macaroon_secret"
    printf 'FORM_SECRET=%s\n' "$form_secret"
    printf 'MESH_ADMISSION_SIGNING_KEY=%s\n' "$admission_signing_key"
    printf 'MESH_ADMISSION_SIGNING_KEY_ID=%s\n' "$(printf '%s' "$admission_signing_key" | sha256sum | cut -c1-16)"
    printf '%s\n' 'MESH_ADMISSION_PREVIOUS_SIGNING_KEYS='
    printf 'MESH_ADMISSION_SERVICE_USER_ID=@mesh-admission-service:%s\n' "$MESH_SERVER_NAME"
    printf '%s\n' 'MESH_ADMISSION_SERVICE_ACCESS_TOKEN=REPLACE_DURING_FIRST_START'
    printf 'ACME_EMAIL=%s\n' "$ACME_EMAIL"
  } > .env
  chmod 600 .env
  echo "Created untracked operator secrets in $script_dir/.env"
fi

# Bind-mounted recovery files must be readable by the same numeric identity
# that Synapse uses inside its container. Normalize these host-specific values
# on every setup, including after a restore onto a different Mac.
runtime_uid="$(id -u)"
runtime_gid="$(id -g)"
next_env="$(mktemp "$script_dir/.env.runtime.XXXXXX")"
awk \
  -v runtime_uid="$runtime_uid" \
  -v runtime_gid="$runtime_gid" \
  '
  /^MESH_RUNTIME_UID=/ {
    if (!saw_uid) print "MESH_RUNTIME_UID=" runtime_uid
    saw_uid = 1
    next
  }
  /^MESH_RUNTIME_GID=/ {
    if (!saw_gid) print "MESH_RUNTIME_GID=" runtime_gid
    saw_gid = 1
    next
  }
  { print }
  END {
    if (!saw_uid) print "MESH_RUNTIME_UID=" runtime_uid
    if (!saw_gid) print "MESH_RUNTIME_GID=" runtime_gid
  }
  ' .env > "$next_env"
chmod 600 "$next_env"
mv "$next_env" .env

admission_signing_key="$(
  sed -n 's/^MESH_ADMISSION_SIGNING_KEY=//p' .env | tail -n 1
)"
generated_admission_signing_key=0
case "$admission_signing_key" in
  ""|REPLACE_*)
    if grep -q '^MESH_ADMISSION_PREVIOUS_SIGNING_KEYS=.' .env; then
      echo "Existing previous admission signing keys cannot be paired with a regenerated current key." >&2
      exit 1
    fi
    admission_signing_key="$(openssl rand -hex 32)"
    generated_admission_signing_key=1
    next_env="$(mktemp "$script_dir/.env.admission.XXXXXX")"
    grep -v '^MESH_ADMISSION_SIGNING_KEY=' .env > "$next_env" || true
    printf 'MESH_ADMISSION_SIGNING_KEY=%s\n' "$admission_signing_key" >> "$next_env"
    chmod 600 "$next_env"
    mv "$next_env" .env
    ;;
esac
admission_signing_key_id="$(
  sed -n 's/^MESH_ADMISSION_SIGNING_KEY_ID=//p' .env | tail -n 1
)"
if [ "$generated_admission_signing_key" -eq 1 ]; then
  admission_signing_key_id=""
fi
case "$admission_signing_key_id" in
  ""|REPLACE_*)
    next_env="$(mktemp "$script_dir/.env.admission-id.XXXXXX")"
    awk \
      -v signing_id="$(printf '%s' "$admission_signing_key" | sha256sum | cut -c1-16)" \
      '
      /^MESH_ADMISSION_SIGNING_KEY_ID=/ {
        if (!saw_id) print "MESH_ADMISSION_SIGNING_KEY_ID=" signing_id
        saw_id = 1
        next
      }
      { print }
      END {
        if (!saw_id) print "MESH_ADMISSION_SIGNING_KEY_ID=" signing_id
      }
      ' .env > "$next_env"
    chmod 600 "$next_env"
    mv "$next_env" .env
    ;;
esac
if ! grep -q '^MESH_ADMISSION_PREVIOUS_SIGNING_KEYS=' .env; then
  printf '%s\n' 'MESH_ADMISSION_PREVIOUS_SIGNING_KEYS=' >> .env
  chmod 600 .env
fi
if ! grep -q '^MESH_ADMISSION_SERVICE_USER_ID=' .env; then
  printf 'MESH_ADMISSION_SERVICE_USER_ID=@mesh-admission-service:%s\n' "$MESH_SERVER_NAME" >> .env
  chmod 600 .env
fi
if ! grep -q '^MESH_ADMISSION_SERVICE_ACCESS_TOKEN=' .env; then
  printf '%s\n' 'MESH_ADMISSION_SERVICE_ACCESS_TOKEN=REPLACE_DURING_FIRST_START' >> .env
  chmod 600 .env
fi
admission_db_password="$(
  sed -n 's/^MESH_ADMISSION_DB_PASSWORD=//p' .env | tail -n 1
)"
case "$admission_db_password" in
  ""|REPLACE_*)
    admission_db_password="$(openssl rand -hex 32)"
    next_env="$(mktemp "$script_dir/.env.admission-db.XXXXXX")"
    grep -v '^MESH_ADMISSION_DB_PASSWORD=' .env > "$next_env" || true
    printf 'MESH_ADMISSION_DB_PASSWORD=%s\n' "$admission_db_password" >> "$next_env"
    chmod 600 "$next_env"
    mv "$next_env" .env
    ;;
esac
unset admission_db_password

set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${MESH_SERVER_NAME:?MESH_SERVER_NAME is required}"
: "${MESH_HOMESERVER_HOST:?MESH_HOMESERVER_HOST is required}"
: "${MESH_RTC_ENABLED:=0}"
: "${MESH_REGISTRATION_ENABLED:=1}"
: "${MESH_ABUSE_EMAIL:?MESH_ABUSE_EMAIL is required}"
: "${MESH_OPERATOR_LOCALPART:?MESH_OPERATOR_LOCALPART is required}"
: "${MESH_RUNTIME_UID:?MESH_RUNTIME_UID is required}"
: "${MESH_RUNTIME_GID:?MESH_RUNTIME_GID is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
: "${MESH_ADMISSION_DB_PASSWORD:?MESH_ADMISSION_DB_PASSWORD is required}"
: "${REGISTRATION_SHARED_SECRET:?REGISTRATION_SHARED_SECRET is required}"
: "${MACAROON_SECRET_KEY:?MACAROON_SECRET_KEY is required}"
: "${FORM_SECRET:?FORM_SECRET is required}"
: "${MESH_ADMISSION_SIGNING_KEY:?MESH_ADMISSION_SIGNING_KEY is required}"

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
  --user "$MESH_RUNTIME_UID:$MESH_RUNTIME_GID" \
  -e MESH_SERVER_NAME \
  -e MESH_HOMESERVER_HOST \
  -e MESH_REGISTRATION_ENABLED \
  -e MESH_ABUSE_EMAIL \
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

mkdir -p runtime/well-known
if [ "$MESH_RTC_ENABLED" = "1" ]; then
  : "${MESH_RTC_HOST:?MESH_RTC_HOST is required when MESH_RTC_ENABLED=1}"
  printf '%s\n' \
    "{\"m.homeserver\":{\"base_url\":\"https://$MESH_HOMESERVER_HOST\"},\"org.mesh.admission\":{\"service_url\":\"https://$MESH_SERVER_NAME/_mesh/admission\"},\"org.matrix.msc4143.rtc_foci\":[{\"type\":\"livekit\",\"livekit_service_url\":\"https://$MESH_RTC_HOST/livekit/jwt\"}]}" \
    > runtime/well-known/matrix-client.json
else
  printf '%s\n' \
    "{\"m.homeserver\":{\"base_url\":\"https://$MESH_HOMESERVER_HOST\"},\"org.mesh.admission\":{\"service_url\":\"https://$MESH_SERVER_NAME/_mesh/admission\"}}" \
    > runtime/well-known/matrix-client.json
fi
chmod 644 runtime/well-known/matrix-client.json

docker compose config --quiet
echo "Homeserver configuration is ready."
