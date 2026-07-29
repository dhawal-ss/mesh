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

docker compose up -d postgres synapse

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

admission_token="${MESH_ADMISSION_ADMIN_ACCESS_TOKEN:-}"
admission_token_is_valid() {
  printf '%s' "$admission_token" |
    docker compose exec -T synapse python -c '
import json
import os
import sys
import urllib.request

token = sys.stdin.read()
request = urllib.request.Request(
    "http://127.0.0.1:8008/_matrix/client/v3/account/whoami",
    headers={"Authorization": "Bearer " + token},
)
try:
    with urllib.request.urlopen(request, timeout=10) as response:
        payload = json.load(response)
except Exception:
    raise SystemExit(1)
expected = "@mesh-admission-service:" + os.environ["MESH_SERVER_NAME"]
raise SystemExit(0 if payload.get("user_id") == expected else 1)
' >/dev/null 2>&1
}

if ! admission_token_is_valid; then
  admin_password="$(
    security find-generic-password \
      -a "$admin_user" \
      -s "$admin_service" \
      -w
  )"
  service_password="$(openssl rand -base64 36 | tr -d '\n')"
  admission_token="$(
    {
      printf '%s\n' "$admin_password"
      printf '%s\n' "$service_password"
    } |
      docker compose exec -T \
        -e "MESH_OPERATOR_USER=$admin_user" \
        synapse \
        python /mesh/bootstrap_admission_service.py
  )"
  unset admin_password service_password
  case "$admission_token" in
    ""|*[!A-Za-z0-9._~-]*)
      echo "Synapse returned an invalid admission service token." >&2
      unset admission_token
      exit 1
      ;;
  esac

  next_env="$(mktemp "$script_dir/.env.admission-token.XXXXXX")"
  grep -v '^MESH_ADMISSION_ADMIN_ACCESS_TOKEN=' .env > "$next_env" || true
  printf 'MESH_ADMISSION_ADMIN_ACCESS_TOKEN=%s\n' "$admission_token" >> "$next_env"
  chmod 600 "$next_env"
  mv "$next_env" .env
  echo "Provisioned the dedicated Mesh admission service account."
fi
unset admission_token

docker compose up -d admission
deadline=$(( $(date +%s) + 120 ))
until admission_container="$(docker compose ps -q admission)" &&
  [ -n "$admission_container" ] &&
  [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$admission_container")" = "healthy" ]
do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "The Mesh admission service did not become healthy within 120 seconds." >&2
    exit 1
  fi
  sleep 2
done

if [ "${MESH_PUBLIC_ENABLED:-0}" = "1" ]; then
  docker compose --profile public up -d caddy
fi
