#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$script_dir"
# shellcheck source=infra/homeserver/operational-health-lib.sh
. "$script_dir/operational-health-lib.sh"

local_max_seconds="${MESH_LOCAL_BACKUP_MAX_SECONDS:-93600}"
offsite_max_seconds="${MESH_OFFSITE_BACKUP_MAX_SECONDS:-93600}"
drill_max_seconds="${MESH_RESTORE_DRILL_MAX_SECONDS:-2678400}"
minimum_free_percent="${MESH_MINIMUM_FREE_DISK_PERCENT:-15}"

for value in \
  "$local_max_seconds" \
  "$offsite_max_seconds" \
  "$drill_max_seconds" \
  "$minimum_free_percent"
do
  case "$value" in
    *[!0-9]*|"")
      echo '{"status":"error","reason":"invalid monitoring configuration"}'
      exit 1
      ;;
  esac
done

check_container() {
  service="$1"
  container_id="$(docker compose ps -q "$service")"
  if [ -z "$container_id" ]; then
    echo "$service container is not running." >&2
    return 1
  fi
  state="$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container_id")"
  if [ "$state" != "running healthy" ]; then
    echo "$service container state is $state." >&2
    return 1
  fi
}

check_container postgres
check_container synapse
check_container admission
curl --fail --silent http://127.0.0.1:8008/health >/dev/null
curl --fail --silent \
  http://127.0.0.1:8008/_matrix/client/versions >/dev/null
docker compose exec -T admission python -c \
  "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/healthz', timeout=3).read()" \
  >/dev/null

check_fresh_status \
  "$script_dir/runtime/status/local-backup-status.json" \
  "$local_max_seconds" \
  "Local backup"
check_fresh_status \
  "$script_dir/runtime/status/offsite-backup-status.json" \
  "$offsite_max_seconds" \
  "Offsite backup"
check_fresh_status \
  "$script_dir/runtime/status/restore-drill-status.json" \
  "$drill_max_seconds" \
  "Restore drill"

free_percent="$(
  df -Pk "$script_dir/runtime" |
    awk 'NR == 2 { gsub(/%/, "", $5); print 100 - $5 }'
)"
if [ -z "$free_percent" ] || [ "$free_percent" -lt "$minimum_free_percent" ]; then
  if grep -Eq '^MESH_REGISTRATION_ENABLED=1$' "$script_dir/.env" 2>/dev/null; then
    if ! "$script_dir/registration-control.sh" close >&2; then
      echo "Homeserver disk pressure was detected, but account creation could not be closed automatically." >&2
    fi
  fi
  echo "Homeserver disk has only ${free_percent:-unknown}% free." >&2
  exit 1
fi

echo '{"status":"ok"}'
