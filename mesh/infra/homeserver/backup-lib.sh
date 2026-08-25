#!/bin/sh

assert_no_otk_table_data() {
  if grep -Eq '[[:space:]]TABLE DATA[[:space:]]+[^[:space:]]+[[:space:]]+e2e_one_time_keys_json([[:space:]]|$)'; then
    echo "PostgreSQL dump contains e2e_one_time_keys_json table data; refusing restore." >&2
    return 1
  fi
}

assert_host_owned_readable_file() (
  recovery_file="$1"

  if [ ! -f "$recovery_file" ] ||
     [ -L "$recovery_file" ] ||
     [ ! -s "$recovery_file" ] ||
     [ ! -r "$recovery_file" ]
  then
    echo "Recovery artifact is not a safe, non-empty host-readable file: $recovery_file" >&2
    return 1
  fi

  host_uid="$(id -u)"
  file_uid="$(stat -c '%u' "$recovery_file" 2>/dev/null || stat -f '%u' "$recovery_file" 2>/dev/null || true)"
  if [ -n "$file_uid" ] && [ "$file_uid" != "$host_uid" ]; then
    echo "Recovery artifact is owned by UID $file_uid instead of invoking host UID $host_uid: $recovery_file" >&2
    return 1
  fi
)

stream_recovery_artifact() (
  destination="$1"
  shift

  if [ "$#" -eq 0 ]; then
    echo "A recovery-artifact producer command is required." >&2
    return 1
  fi
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    echo "Refusing to replace an existing recovery artifact: $destination" >&2
    return 1
  fi

  # The invoking shell creates the destination, while the producer may read
  # protected data under a narrower container identity. This keeps the final
  # artifact private, host-owned, and usable by offsite and restore tooling.
  if ! "$@" > "$destination"; then
    rm -f -- "$destination"
    echo "Could not stream recovery data into $destination." >&2
    return 1
  fi
  if ! assert_host_owned_readable_file "$destination"; then
    rm -f -- "$destination"
    return 1
  fi
)

backup_week_key() {
  backup_day="$1"
  if backup_week="$(date -u -d "$backup_day" +%G-W%V 2>/dev/null)"; then
    printf '%s\n' "$backup_week"
    return 0
  fi
  if backup_week="$(date -u -j -f "%Y%m%d" "$backup_day" +%G-W%V 2>/dev/null)"; then
    printf '%s\n' "$backup_week"
    return 0
  fi
  echo "Unable to determine the calendar week for backup date: $backup_day" >&2
  return 1
}

prune_local_backups() {
  backup_root="$1"
  current_backup="$2"
  keep_daily="$3"
  keep_weekly="$4"
  if [ ! -d "$backup_root" ] || [ -L "$backup_root" ]; then
    echo "Backup retention root must be a real directory: $backup_root" >&2
    return 1
  fi
  backup_root="$(CDPATH= cd -- "$backup_root" && pwd -P)"
  case "$backup_root" in
    ""|"/")
      echo "Refusing to prune an empty or filesystem-root backup path." >&2
      return 1
      ;;
  esac
  current_name="$(basename "$current_backup")"
  backup_names="$(
    for backup_path in "$backup_root"/20??????T??????Z; do
      if [ -d "$backup_path" ] && [ ! -L "$backup_path" ]; then
        basename "$backup_path"
      fi
    done | sort -r
  )"
  daily_keys='|'
  weekly_keys='|'
  daily_count=0
  weekly_count=0

  for backup_name in $backup_names; do
    case "$backup_name" in
      [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
      *) continue ;;
    esac

    backup_day="${backup_name%%T*}"
    backup_week="$(backup_week_key "$backup_day")"
    keep_backup=0
    if [ "$backup_name" = "$current_name" ]; then
      keep_backup=1
    fi

    case "$daily_keys" in
      *"|$backup_day|"*) ;;
      *)
        if [ "$daily_count" -lt "$keep_daily" ]; then
          daily_keys="${daily_keys}${backup_day}|"
          daily_count=$((daily_count + 1))
          keep_backup=1
        fi
        ;;
    esac

    case "$weekly_keys" in
      *"|$backup_week|"*) ;;
      *)
        if [ "$weekly_count" -lt "$keep_weekly" ]; then
          weekly_keys="${weekly_keys}${backup_week}|"
          weekly_count=$((weekly_count + 1))
          keep_backup=1
        fi
        ;;
    esac

    if [ "$keep_backup" -eq 0 ]; then
      rm -rf -- "${backup_root:?}/$backup_name"
    fi
  done
}
