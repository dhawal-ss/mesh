#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$script_dir"
umask 077

case "${1:-}" in
  close)
    next_value=0
    ;;
  open)
    next_value=1
    ;;
  status)
    value="$(sed -n 's/^MESH_REGISTRATION_ENABLED=//p' .env 2>/dev/null | tail -n 1)"
    case "$value" in
      1) echo "Token-gated account creation is enabled." ;;
      *) echo "Account creation is closed." ;;
    esac
    exit 0
    ;;
  *)
    echo "usage: $0 close|open|status" >&2
    exit 2
    ;;
esac

if [ ! -f .env ]; then
  echo "Run setup.sh before changing account creation." >&2
  exit 1
fi

next_env="$(mktemp "$script_dir/.env.registration.XXXXXX")"
awk -v next_value="$next_value" '
  /^MESH_REGISTRATION_ENABLED=/ {
    if (!found) print "MESH_REGISTRATION_ENABLED=" next_value
    found = 1
    next
  }
  { print }
  END {
    if (!found) print "MESH_REGISTRATION_ENABLED=" next_value
  }
' .env > "$next_env"
chmod 600 "$next_env"
mv "$next_env" .env

./setup.sh
docker compose restart synapse

if [ "$next_value" = "0" ]; then
  echo "Emergency shutdown complete: account creation is closed; existing accounts remain usable."
else
  echo "Token-gated account creation is enabled. Public registration remains unavailable."
fi
