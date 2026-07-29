#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$script_dir"
umask 077

if ! command -v restic >/dev/null 2>&1; then
  echo "restic is required for encrypted offsite backups." >&2
  exit 1
fi
: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY must name the offsite backup repository}"
if [ -z "${RESTIC_PASSWORD:-}" ] &&
   [ -z "${RESTIC_PASSWORD_FILE:-}" ] &&
   [ -z "${RESTIC_PASSWORD_COMMAND:-}" ]
then
  echo "Inject a restic repository password through the operator secret store." >&2
  exit 1
fi

check_subset="${MESH_RESTIC_CHECK_SUBSET:-5%}"
if ! printf '%s' "$check_subset" |
   grep -Eq '^([1-9][0-9]*%|[1-9][0-9]*/[1-9][0-9]*)$'
then
  echo "MESH_RESTIC_CHECK_SUBSET must be a restic subset such as 5% or 1/20." >&2
  exit 1
fi

backup_path="$(sh "$script_dir/backup.sh")"
sh "$script_dir/verify-backup.sh" "$backup_path" >&2

server_name="$(
  awk -F= '$1 == "MESH_SERVER_NAME" { sub(/^[^=]*=/, ""); print; exit }' \
    "$backup_path/operator.env"
)"
restic backup \
  --host "$server_name" \
  --tag mesh-homeserver \
  "$backup_path"
restic snapshots --latest 1 --tag mesh-homeserver >/dev/null
restic check --read-data-subset="$check_subset"

status_root="$script_dir/runtime/status"
mkdir -p "$status_root"
completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
backup_id="$(basename "$backup_path")"
status_tmp="$status_root/.offsite-backup-status.$$"
printf '%s\n' \
  "{\"status\":\"ok\",\"lastSuccessfulAt\":\"$completed_at\",\"backupId\":\"$backup_id\",\"verification\":\"restic-$check_subset\"}" \
  > "$status_tmp"
chmod 600 "$status_tmp"
mv "$status_tmp" "$status_root/offsite-backup-status.json"

echo "Encrypted offsite backup and repository data check completed: $backup_id"
