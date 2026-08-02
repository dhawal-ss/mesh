#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 /path/to/backup" >&2
  exit 2
fi

backup_dir="${1%/}"
if [ ! -d "$backup_dir" ] || [ -L "$backup_dir" ]; then
  echo "Backup directory is missing or is a symbolic link: $backup_dir" >&2
  exit 1
fi

for secret_file in "$backup_dir/.env" "$backup_dir/operator.env"; do
  if [ -e "$secret_file" ] || [ -L "$secret_file" ]; then
    echo "Backup contains plaintext operator secrets: $(basename "$secret_file")" >&2
    exit 1
  fi
done
for env_file in "$backup_dir"/*.env; do
  if [ -e "$env_file" ] || [ -L "$env_file" ]; then
    case "$(basename "$env_file")" in
      backup-metadata.env) ;;
      *)
        echo "Backup contains an unexpected plaintext environment file: $(basename "$env_file")" >&2
        exit 1
        ;;
    esac
  fi
done

for required_file in \
  manifest.sha256 \
  backup-metadata.env \
  postgres.dump \
  synapse-critical.tar.gz
do
  if [ ! -f "$backup_dir/$required_file" ] || [ -L "$backup_dir/$required_file" ]; then
    echo "Backup file is missing or unsafe: $required_file" >&2
    exit 1
  fi
done

if [ -e "$backup_dir/media-store.tar.gz" ] &&
   { [ ! -f "$backup_dir/media-store.tar.gz" ] || [ -L "$backup_dir/media-store.tar.gz" ]; }
then
  echo "Backup media archive is unsafe." >&2
  exit 1
fi

manifest="$backup_dir/manifest.sha256"
manifest_entries=0
seen_metadata=0
seen_postgres=0
seen_critical=0
seen_media=0

while IFS= read -r raw_line || [ -n "$raw_line" ]; do
  line="$(printf '%s' "$raw_line" | tr -d '\r')"
  hash="${line%%  *}"
  file="${line#*  }"
  if [ "$file" = "$line" ] ||
     ! printf '%s' "$hash" | grep -Eq '^[0-9a-fA-F]{64}$'
  then
    echo "Backup manifest contains an invalid checksum line." >&2
    exit 1
  fi

  case "$file" in
    backup-metadata.env)
      [ "$seen_metadata" -eq 0 ] || {
        echo "Backup manifest lists backup-metadata.env more than once." >&2
        exit 1
      }
      seen_metadata=1
      ;;
    postgres.dump)
      [ "$seen_postgres" -eq 0 ] || {
        echo "Backup manifest lists postgres.dump more than once." >&2
        exit 1
      }
      seen_postgres=1
      ;;
    synapse-critical.tar.gz)
      [ "$seen_critical" -eq 0 ] || {
        echo "Backup manifest lists synapse-critical.tar.gz more than once." >&2
        exit 1
      }
      seen_critical=1
      ;;
    media-store.tar.gz)
      [ "$seen_media" -eq 0 ] || {
        echo "Backup manifest lists media-store.tar.gz more than once." >&2
        exit 1
      }
      seen_media=1
      ;;
    *)
      echo "Backup manifest contains an unexpected path: $file" >&2
      exit 1
      ;;
  esac
  manifest_entries=$((manifest_entries + 1))
done < "$manifest"

if [ "$seen_metadata" -ne 1 ] ||
   [ "$seen_postgres" -ne 1 ] ||
   [ "$seen_critical" -ne 1 ]
then
  echo "Backup manifest does not cover every required recovery file." >&2
  exit 1
fi
if [ -f "$backup_dir/media-store.tar.gz" ] && [ "$seen_media" -ne 1 ]; then
  echo "Backup manifest does not cover the media archive." >&2
  exit 1
fi
if [ ! -f "$backup_dir/media-store.tar.gz" ] && [ "$seen_media" -ne 0 ]; then
  echo "Backup manifest references a missing media archive." >&2
  exit 1
fi
expected_entries=$((3 + seen_media))
if [ "$manifest_entries" -ne "$expected_entries" ]; then
  echo "Backup manifest contains duplicate or unexpected entries." >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  (
    cd "$backup_dir"
    sha256sum -c manifest.sha256 >/dev/null
  )
elif command -v shasum >/dev/null 2>&1; then
  (
    cd "$backup_dir"
    shasum -a 256 -c manifest.sha256 >/dev/null
  )
else
  echo "A SHA-256 utility (sha256sum or shasum) is required." >&2
  exit 1
fi

for required_setting in \
  MESH_SERVER_NAME \
  POSTGRES_USER \
  POSTGRES_DB
do
  setting_count="$(
    awk -F= -v key="$required_setting" '$1 == key { count += 1 } END { print count + 0 }' \
      "$backup_dir/backup-metadata.env"
  )"
  if [ "$setting_count" -ne 1 ]; then
    echo "backup-metadata.env must contain exactly one $required_setting setting." >&2
    exit 1
  fi
  setting_value="$(
    awk -F= -v key="$required_setting" \
      '$1 == key { sub(/^[^=]*=/, ""); print; exit }' \
      "$backup_dir/backup-metadata.env"
  )"
  case "$setting_value" in
    ""|REPLACE_*)
      echo "backup-metadata.env contains an unusable $required_setting setting." >&2
      exit 1
      ;;
  esac
done
if grep -Eq '^(POSTGRES_PASSWORD|REGISTRATION_SHARED_SECRET|MACAROON_SECRET_KEY|FORM_SECRET|MESH_ADMISSION_SIGNING_KEY|MESH_ADMISSION_ADMIN_ACCESS_TOKEN|MESH_ADMISSION_SERVICE_ACCESS_TOKEN)=' \
  "$backup_dir/backup-metadata.env"
then
  echo "backup-metadata.env contains a runtime secret." >&2
  exit 1
fi

validate_archive_paths() {
  archive="$1"
  allowed_prefix="$2"
  if ! tar -tzf "$archive" | while IFS= read -r entry; do
    case "$entry" in
      ""|/*|../*|*/../*|*/..)
        echo "Backup archive contains an unsafe path: $entry" >&2
        exit 1
        ;;
    esac
    if [ -n "$allowed_prefix" ]; then
      case "$entry" in
        "$allowed_prefix"|"$allowed_prefix"/*) ;;
        *)
          echo "Backup archive contains an unexpected path: $entry" >&2
          exit 1
          ;;
      esac
    fi
  done
  then
    exit 1
  fi
  if ! tar -tvzf "$archive" | awk '
    substr($1, 1, 1) == "l" || substr($1, 1, 1) == "h" { unsafe = 1 }
    END { exit unsafe }
  '
  then
    echo "Backup archive contains a symbolic or hard link." >&2
    exit 1
  fi
}

validate_archive_paths "$backup_dir/synapse-critical.tar.gz" ""
critical_entries="$(tar -tzf "$backup_dir/synapse-critical.tar.gz")"
server_name="$(
  awk -F= '$1 == "MESH_SERVER_NAME" { sub(/^[^=]*=/, ""); print; exit }' \
    "$backup_dir/backup-metadata.env"
)"
for critical_file in \
  homeserver.yaml \
  "$server_name.signing.key" \
  "$server_name.log.config"
do
  if ! printf '%s\n' "$critical_entries" | grep -Fqx "$critical_file"; then
    echo "Critical archive is missing $critical_file." >&2
    exit 1
  fi
done
critical_count="$(printf '%s\n' "$critical_entries" | grep -c .)"
if [ "$critical_count" -ne 3 ]; then
  echo "Critical archive contains unexpected files." >&2
  exit 1
fi

if [ -f "$backup_dir/media-store.tar.gz" ]; then
  validate_archive_paths "$backup_dir/media-store.tar.gz" "media_store"
fi

echo "Verified backup integrity and recovery contents: $backup_dir"
