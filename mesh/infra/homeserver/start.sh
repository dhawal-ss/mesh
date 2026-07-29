#!/bin/sh
set -eu

PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$script_dir"

if [ ! -f .env ]; then
  echo "Missing .env. Run ./setup.sh first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

if ! docker info >/dev/null 2>&1; then
  docker desktop start --detach
fi

attempt=0
until docker info >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 90 ]; then
    echo "Docker did not become ready within 90 seconds." >&2
    exit 1
  fi
  sleep 1
done

if [ "${MESH_PUBLIC_ENABLED:-0}" = "1" ]; then
  docker compose --profile public up -d
else
  docker compose up -d postgres synapse
fi

deadline=$(( $(date +%s) + 120 ))
until curl --fail --silent http://127.0.0.1:8008/health >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "Synapse did not become healthy within 120 seconds." >&2
    exit 1
  fi
  sleep 2
done

admin_user="@dhawal:${MESH_SERVER_NAME}"
admin_service="Mesh Homeserver Admin"
if ! security find-generic-password -a "$admin_user" -s "$admin_service" -w >/dev/null 2>&1; then
  admin_password="$(openssl rand -base64 36 | tr -d '\n')"
  if ! docker compose exec -T synapse register_new_matrix_user \
    -c /data/homeserver.yaml http://127.0.0.1:8008 \
    -u dhawal -p "$admin_password" --admin >/dev/null; then
    echo "Could not bootstrap $admin_user. The account may already exist without a matching Keychain entry." >&2
    echo "Recover or reset that account locally, then store its password under '$admin_service'." >&2
    unset admin_password
    exit 1
  fi
  security add-generic-password -U \
    -a "$admin_user" \
    -s "$admin_service" \
    -w "$admin_password" >/dev/null
  unset admin_password
  echo "Created the local Mesh operator account and stored its password in macOS Keychain."
fi
