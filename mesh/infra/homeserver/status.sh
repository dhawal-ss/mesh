#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$script_dir"

docker compose ps
echo
curl --fail --silent --show-error http://127.0.0.1:8008/health
echo
curl --fail --silent --show-error \
  http://127.0.0.1:8008/_matrix/client/versions
echo
df -h "$script_dir/runtime"
du -sh "$script_dir/runtime/postgres" "$script_dir/runtime/synapse" 2>/dev/null
