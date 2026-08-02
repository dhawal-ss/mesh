#!/bin/sh

healthy_status_epoch() {
  status_path="$1"
  python3 - "$status_path" <<'PY'
import datetime
import json
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
raw = path.read_bytes()
if len(raw) > 64 * 1024:
    raise SystemExit("status file is too large")

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate field: {key}")
        result[key] = value
    return result

document = json.loads(raw, object_pairs_hook=unique_object)
if not isinstance(document, dict) or document.get("status") != "ok":
    raise SystemExit("status is not healthy")
timestamp = document.get("lastSuccessfulAt")
if not isinstance(timestamp, str) or not re.fullmatch(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z", timestamp
):
    raise SystemExit("lastSuccessfulAt is not a UTC ISO timestamp")
try:
    parsed = datetime.datetime.fromisoformat(timestamp[:-1] + "+00:00")
except ValueError as error:
    raise SystemExit("lastSuccessfulAt is invalid") from error
print(int(parsed.timestamp()))
PY
}

check_fresh_status() {
  status_file="$1"
  maximum_age="$2"
  label="$3"
  if [ ! -f "$status_file" ] || [ -L "$status_file" ]; then
    echo "$label status is missing." >&2
    return 1
  fi

  if ! completed_epoch="$(healthy_status_epoch "$status_file" 2>/dev/null)"; then
    echo "$label status is invalid or not healthy." >&2
    return 1
  fi
  case "$completed_epoch" in
    ''|*[!0-9]*)
      echo "$label status has an invalid last-success timestamp." >&2
      return 1
      ;;
  esac

  now="${MESH_HEALTH_NOW_EPOCH:-$(date +%s)}"
  case "$now" in
    ''|*[!0-9]*)
      echo "$label health clock is invalid." >&2
      return 1
      ;;
  esac
  age=$((now - completed_epoch))
  if [ "$age" -lt 0 ]; then
    echo "$label status timestamp is in the future." >&2
    return 1
  fi
  if [ "$age" -gt "$maximum_age" ]; then
    echo "$label status is stale (${age}s old)." >&2
    return 1
  fi
}
