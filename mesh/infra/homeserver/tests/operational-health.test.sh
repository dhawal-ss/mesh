#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
homeserver_dir="$(CDPATH= cd -- "$script_dir/.." && pwd)"
test_root="$(mktemp -d)"

cleanup() {
  rm -rf -- "$test_root"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# shellcheck source=infra/homeserver/operational-health-lib.sh
. "$homeserver_dir/operational-health-lib.sh"

now=1785646800
export MESH_HEALTH_NOW_EPOCH="$now"
status_file="$test_root/status.json"

expect_rejected() {
  description="$1"
  if check_fresh_status "$status_file" 3600 "Test backup" >/dev/null 2>&1; then
    echo "Operational health accepted $description." >&2
    exit 1
  fi
}

printf '%s\n' '{"status":"ok","lastSuccessfulAt":"2026-08-02T04:30:00Z"}' > "$status_file"
check_fresh_status "$status_file" 3600 "Test backup"

# A fresh file modification must not make a stale embedded timestamp healthy.
printf '%s\n' '{"status":"ok","lastSuccessfulAt":"2026-08-01T00:00:00Z"}' > "$status_file"
expect_rejected "a stale embedded timestamp"

printf '%s\n' '{"status":"ok","lastSuccessfulAt":"2026-08-02T05:00:01Z"}' > "$status_file"
expect_rejected "a future embedded timestamp"

for timestamp in \
  'not-a-date' \
  '2026-02-30T00:00:00Z' \
  '2026-08-02T05:00:00' \
  '2026-08-02 05:00:00Z' \
  '2026-08-02T05:00:00+00:00'
do
  printf '{"status":"ok","lastSuccessfulAt":"%s"}\n' "$timestamp" > "$status_file"
  expect_rejected "invalid timestamp $timestamp"
done

printf '%s\n' '{"status":"failed","lastSuccessfulAt":"2026-08-02T04:30:00Z"}' > "$status_file"
expect_rejected "an unhealthy status"

printf '%s\n' '{"status":"failed","status":"ok","lastSuccessfulAt":"2026-08-02T04:30:00Z"}' > "$status_file"
expect_rejected "duplicate tampered status fields"

printf '%s\n' '{"status":"ok","lastSuccessfulAt":"2026-08-02T04:30:00Z"}' > "$test_root/target.json"
rm -f "$status_file"
ln -s "$test_root/target.json" "$status_file"
if [ -L "$status_file" ]; then
  expect_rejected "a symlinked status file"
fi

echo "Operational health embedded-timestamp tests passed."
