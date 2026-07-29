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
