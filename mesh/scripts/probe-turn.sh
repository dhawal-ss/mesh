#!/usr/bin/env bash
# probe-turn.sh — Probe a real deployed TURN server using Mesh's RFC 5766
# Allocate-with-HMAC-SHA1 implementation.
#
# This wraps the `turn_probe_live_tests` integration test with a friendly
# CLI. It's the fastest way for an operator to answer "is my TURN server
# working?" without launching the full Mesh app.
#
# Prefer process-scoped environment variables so credentials do not appear in
# shell history or process arguments:
#   MESH_TURN_URL=turn:turn.example.com:3478 \
#   MESH_TURN_USERNAME=alice \
#   MESH_TURN_PASSWORD=hunter2 \
#   ./scripts/probe-turn.sh
#
# Optional: set MESH_TURN_EXPECT to assert a specific outcome (for
# regression testing, e.g. in CI):
#   MESH_TURN_EXPECT=allocation_ok ./scripts/probe-turn.sh ...

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Allow positional args OR env vars
if [ "$#" -ge 3 ]; then
  echo "WARNING: positional TURN credentials may be retained in shell history. Prefer MESH_TURN_* environment variables." >&2
  export MESH_TURN_URL="$1"
  export MESH_TURN_USERNAME="$2"
  export MESH_TURN_PASSWORD="$3"
fi

if [ -z "${MESH_TURN_URL:-}" ] || [ -z "${MESH_TURN_USERNAME:-}" ] || [ -z "${MESH_TURN_PASSWORD:-}" ]; then
  echo "Usage: $0 <turn-url> <username> <password>"
  echo
  echo "  <turn-url>   e.g. turn:turn.example.com:3478"
  echo "  <username>   TURN long-term credential username"
  echo "  <password>   TURN long-term credential password"
  echo
  echo "Or set MESH_TURN_URL, MESH_TURN_USERNAME, MESH_TURN_PASSWORD."
  exit 1
fi

case "$MESH_TURN_URL" in
  turns:*)
    if [ "${MESH_TURN_EXPECT:-}" = "allocation_ok" ]; then
      echo "The standalone probe cannot validate TLS or Allocate for turns: URLs." >&2
      echo "Use turn: for the authenticated UDP Allocate probe, then prove TURN/TLS with a relay-only client call." >&2
      exit 1
    fi
    ;;
esac

cd "$REPO_ROOT/src-tauri"

echo "────────────────────────────────────────────────"
echo "  Mesh TURN Probe"
echo "────────────────────────────────────────────────"
echo "  URL:      $MESH_TURN_URL"
echo "  Username: $MESH_TURN_USERNAME"
echo "  Password: ***"
if [ -n "${MESH_TURN_EXPECT:-}" ]; then
  echo "  Expect:   $MESH_TURN_EXPECT (regression mode)"
fi
echo "────────────────────────────────────────────────"
echo

set +e
cargo test \
  --no-default-features \
  --features legacy-p2p \
  --locked \
  --jobs 1 \
  --test turn_probe_live_tests \
  -- --ignored --nocapture probes_real_turn_server_with_credentials

exit_code=$?
set -e
echo
if [ "$exit_code" -eq 0 ]; then
  echo "✓ Probe completed. Review the output above for outcome classification."
else
  echo "✗ Probe failed. Check logs above and verify:"
  echo "   - TURN server is running and reachable on the given port"
  echo "   - UDP is not blocked by a firewall between you and the server"
  echo "   - Credentials match the TURN long-term credential config"
fi
exit "$exit_code"
