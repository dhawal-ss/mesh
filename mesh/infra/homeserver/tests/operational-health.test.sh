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

fixture="$test_root/fixture"
mkdir -p "$fixture"
printf 'status fixture\n' > "$fixture/status.json"

# The native stat command covers the platform running this test. The helper
# must return one numeric timestamp rather than filesystem-summary output.
# shellcheck source=infra/homeserver/operational-health-lib.sh
. "$homeserver_dir/operational-health-lib.sh"
native_mtime="$(file_mtime "$fixture/status.json")"
case "$native_mtime" in
  ''|*[!0-9]*)
    echo "Native stat helper returned a non-numeric timestamp: $native_mtime" >&2
    exit 1
    ;;
esac

fake_bin="$test_root/bin"
mkdir -p "$fake_bin"
printf '%s\n' "$native_mtime" > "$fake_bin/fallback-mtime"
cat > "$fake_bin/stat" <<'EOF'
#!/bin/sh
case "$1" in
  -c)
    printf 'GNU stat filesystem summary\n'
    exit 1
    ;;
  -f)
    cat "$FAKE_STAT_MTIME_FILE"
    exit 0
    ;;
  *)
    echo "unexpected stat invocation" >&2
    exit 1
    ;;
esac
EOF
chmod 700 "$fake_bin/stat"

fallback_mtime="$(PATH="$fake_bin:$PATH" FAKE_STAT_MTIME_FILE="$fake_bin/fallback-mtime" file_mtime "$fixture/status.json")"
if [ "$fallback_mtime" != "$native_mtime" ]; then
  echo "BSD stat fallback returned $fallback_mtime; expected $native_mtime." >&2
  exit 1
fi

if file_mtime "$fixture/missing.json" >/dev/null 2>&1; then
  echo "file_mtime accepted a missing file." >&2
  exit 1
fi

echo "Operational health mtime portability tests passed."
