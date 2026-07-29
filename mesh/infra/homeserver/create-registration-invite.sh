#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$script_dir"

if [ ! -f .env ]; then
  echo "Missing .env. Run ./setup.sh and ./start.sh first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

days="${1:-7}"
uses="${2:-1}"
case "$days" in *[!0-9]*|'') echo "Days must be a number." >&2; exit 1;; esac
case "$uses" in *[!0-9]*|'') echo "Uses must be a number." >&2; exit 1;; esac

admin_user="@dhawal:${MESH_SERVER_NAME}"
MESH_ADMIN_PASSWORD="$(security find-generic-password \
  -a "$admin_user" \
  -s 'Mesh Homeserver Admin' \
  -w 2>/dev/null)" || {
    echo "The Mesh operator password is missing from macOS Keychain. Run ./start.sh first." >&2
    exit 1
  }
export MESH_ADMIN_PASSWORD

docker compose exec -T \
  -e MESH_ADMIN_PASSWORD \
  -e MESH_SERVER_NAME \
  synapse python /mesh/create_registration_invite.py \
  --days "$days" \
  --uses "$uses"

unset MESH_ADMIN_PASSWORD
