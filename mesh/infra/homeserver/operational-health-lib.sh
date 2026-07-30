#!/bin/sh

file_mtime() {
  file_mtime_path="$1"
  if file_mtime_value="$(stat -c %Y "$file_mtime_path" 2>/dev/null)"; then
    printf '%s\n' "$file_mtime_value"
    return 0
  fi
  if file_mtime_value="$(stat -f %m "$file_mtime_path" 2>/dev/null)"; then
    printf '%s\n' "$file_mtime_value"
    return 0
  fi
  echo "Could not read modification time for: $file_mtime_path" >&2
  return 1
}
