#!/usr/bin/env bash
# nightly-soak.sh — Run Mesh's long-duration soak and leak-detection tests
# and capture full output to a timestamped log file. Intended for nightly
# CI or manual regression runs before releases.
#
# Runs:
#   1. leak_detection_soak_60s  (60-second two-phase soak with counter
#                                ratio assertion)
#   2. repeated_topology_churn_45s (45-second continuous peer replacement)
#   3. All other fast live_network_tests (13 tests, ~70 seconds)
#
# Total runtime: ~4 minutes.
#
# Exit codes:
#   0 — all tests passed
#   1 — one or more tests failed (log contains details)
#   2 — setup/tooling error
#
# Usage:
#   ./scripts/nightly-soak.sh                    # run everything
#   ./scripts/nightly-soak.sh --soak-only        # skip fast live tests
#   ./scripts/nightly-soak.sh --fast-only        # skip 60s+ soak tests

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$REPO_ROOT/soak-logs"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
LOG_FILE="$LOG_DIR/soak-$TIMESTAMP.log"

SOAK_ONLY=false
FAST_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --soak-only) SOAK_ONLY=true ;;
    --fast-only) FAST_ONLY=true ;;
    -h|--help)
      head -20 "$0" | tail -15
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG_FILE"
}

run_test() {
  local label="$1"
  shift
  log "── $label ──"
  if "$@" 2>&1 | tee -a "$LOG_FILE"; then
    log "✓ $label PASSED"
    return 0
  else
    log "✗ $label FAILED"
    return 1
  fi
}

cd "$REPO_ROOT/src-tauri" || { log "FATAL: cannot cd to src-tauri"; exit 2; }

log "Mesh nightly soak regression starting"
log "Repo: $REPO_ROOT"
log "Log:  $LOG_FILE"
log ""

FAILED=0

if ! $SOAK_ONLY; then
  run_test "fast live libp2p tests (13 tests, ~70s)" \
    cargo test --no-default-features --features legacy-p2p --locked --jobs 1 \
      --test live_network_tests -- --ignored --test-threads=1 \
      --skip leak_detection_soak_60s \
      --skip repeated_topology_churn_45s \
    || FAILED=$((FAILED + 1))
fi

if ! $FAST_ONLY; then
  run_test "60s leak-detection soak" \
    cargo test --no-default-features --features legacy-p2p --locked --jobs 1 \
      --test live_network_tests leak_detection_soak_60s \
      -- --ignored --nocapture \
    || FAILED=$((FAILED + 1))

  run_test "45s topology churn soak" \
    cargo test --no-default-features --features legacy-p2p --locked --jobs 1 \
      --test live_network_tests repeated_topology_churn_45s \
      -- --ignored --nocapture \
    || FAILED=$((FAILED + 1))
fi

log ""
log "──────────────────────────────────────────"
if [ "$FAILED" -eq 0 ]; then
  log "✓ ALL TESTS PASSED"
  log "Log saved to $LOG_FILE"
  exit 0
else
  log "✗ $FAILED test group(s) FAILED"
  log "Log saved to $LOG_FILE"
  exit 1
fi
