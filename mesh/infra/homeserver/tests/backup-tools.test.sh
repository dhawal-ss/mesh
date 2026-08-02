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

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

write_manifest() {
  fixture="$1"
  {
    for file in \
      backup-metadata.env \
      postgres.dump \
      synapse-critical.tar.gz \
      media-store.tar.gz
    do
      if [ -f "$fixture/$file" ]; then
        printf '%s  %s\n' "$(sha256_file "$fixture/$file")" "$file"
      fi
    done
  } > "$fixture/manifest.sha256"
}

make_fixture() {
  fixture="$1"
  mkdir -p "$fixture/critical" "$fixture/media/media_store/local_content"
  cat > "$fixture/backup-metadata.env" <<'EOF'
MESH_SERVER_NAME=mesh.example.test
POSTGRES_USER=synapse
POSTGRES_DB=synapse
EOF
  printf 'synthetic custom-format database dump\n' > "$fixture/postgres.dump"
  printf 'server_name: mesh.example.test\n' > "$fixture/critical/homeserver.yaml"
  printf 'private signing key fixture\n' > "$fixture/critical/mesh.example.test.signing.key"
  printf 'log fixture\n' > "$fixture/critical/mesh.example.test.log.config"
  printf 'media fixture\n' > "$fixture/media/media_store/local_content/object"
  tar -czf "$fixture/synapse-critical.tar.gz" \
    -C "$fixture/critical" \
    homeserver.yaml \
    mesh.example.test.signing.key \
    mesh.example.test.log.config
  tar -czf "$fixture/media-store.tar.gz" \
    -C "$fixture/media" \
    media_store
  rm -rf -- "${fixture:?}/critical" "${fixture:?}/media"
  write_manifest "$fixture"
}

valid_fixture="$test_root/valid"
mkdir "$valid_fixture"
make_fixture "$valid_fixture"
sh "$homeserver_dir/verify-backup.sh" "$valid_fixture" >/dev/null

tampered_fixture="$test_root/tampered"
cp -R "$valid_fixture" "$tampered_fixture"
printf 'tampered\n' >> "$tampered_fixture/postgres.dump"
if sh "$homeserver_dir/verify-backup.sh" "$tampered_fixture" >/dev/null 2>&1; then
  echo "verify-backup accepted a checksum mismatch." >&2
  exit 1
fi

missing_fixture="$test_root/missing"
cp -R "$valid_fixture" "$missing_fixture"
rm "$missing_fixture/backup-metadata.env"
if sh "$homeserver_dir/verify-backup.sh" "$missing_fixture" >/dev/null 2>&1; then
  echo "verify-backup accepted a missing operator environment." >&2
  exit 1
fi

uncovered_fixture="$test_root/uncovered"
cp -R "$valid_fixture" "$uncovered_fixture"
grep -v 'media-store.tar.gz' "$uncovered_fixture/manifest.sha256" \
  > "$uncovered_fixture/manifest.next"
mv "$uncovered_fixture/manifest.next" "$uncovered_fixture/manifest.sha256"
if sh "$homeserver_dir/verify-backup.sh" "$uncovered_fixture" >/dev/null 2>&1; then
  echo "verify-backup accepted an uncovered media archive." >&2
  exit 1
fi

plaintext_fixture="$test_root/plaintext"
cp -R "$valid_fixture" "$plaintext_fixture"
printf 'POSTGRES_PASSWORD=plaintext-secret\n' > "$plaintext_fixture/operator.env"
if sh "$homeserver_dir/verify-backup.sh" "$plaintext_fixture" >/dev/null 2>&1; then
  echo "verify-backup accepted a plaintext operator environment." >&2
  exit 1
fi

symlink_fixture="$test_root/symlink"
cp -R "$valid_fixture" "$symlink_fixture"
rm "$symlink_fixture/postgres.dump"
ln -s "$valid_fixture/postgres.dump" "$symlink_fixture/postgres.dump"
if [ -L "$symlink_fixture/postgres.dump" ]; then
  if sh "$homeserver_dir/verify-backup.sh" "$symlink_fixture" >/dev/null 2>&1; then
    echo "verify-backup accepted a symbolic-link recovery file." >&2
    exit 1
  fi
fi

restore_tampered_fixture="$test_root/restore-tampered"
cp -R "$valid_fixture" "$restore_tampered_fixture"
printf 'tampered restore manifest\n' >> "$restore_tampered_fixture/manifest.sha256"
restore_fake_bin="$test_root/restore-fake-bin"
mkdir "$restore_fake_bin"
cat > "$restore_fake_bin/docker" <<'EOF'
#!/bin/sh
echo "docker should not be called after manifest verification fails." >&2
exit 1
EOF
chmod 700 "$restore_fake_bin/docker"
if (
  PATH="$restore_fake_bin:$PATH" \
    sh "$homeserver_dir/restore-drill.sh" "$restore_tampered_fixture" \
    > "$test_root/restore-tampered.log" 2>&1
); then
  echo "restore-drill accepted a tampered manifest." >&2
  exit 1
fi
grep -qi 'manifest' "$test_root/restore-tampered.log"

if (
  PATH="$restore_fake_bin:$PATH" \
  MESH_RESTORE_POSTGRES_PASSWORD=unit-test-postgres \
  MESH_RESTORE_DRILL_RUNTIME_ROOT=relative/runtime \
    sh "$homeserver_dir/restore-drill.sh" "$valid_fixture" \
    > "$test_root/restore-relative-runtime.log" 2>&1
); then
  echo "restore-drill accepted a relative runtime root." >&2
  exit 1
fi
grep -qi 'runtime root must be an absolute path' \
  "$test_root/restore-relative-runtime.log"

backup_tool="$test_root/backup-tool"
mkdir -p \
  "$backup_tool/fake-bin" \
  "$backup_tool/runtime/synapse/media_store/local_content"
cp "$homeserver_dir/backup.sh" "$homeserver_dir/verify-backup.sh" "$backup_tool/"
cp "$homeserver_dir/backup-lib.sh" "$backup_tool/"
cat > "$backup_tool/.env" <<'EOF'
MESH_SERVER_NAME=mesh.example.test
MESH_HOMESERVER_HOST=matrix.mesh.example.test
MESH_PUBLIC_ENABLED=0
MESH_RTC_ENABLED=0
POSTGRES_USER=synapse
POSTGRES_DB=synapse
POSTGRES_PASSWORD=unit-test-postgres
REGISTRATION_SHARED_SECRET=unit-test-registration
MACAROON_SECRET_KEY=unit-test-macaroon
FORM_SECRET=unit-test-form
EOF
printf 'server_name: mesh.example.test\n' \
  > "$backup_tool/runtime/synapse/homeserver.yaml"
printf 'private signing key fixture\n' \
  > "$backup_tool/runtime/synapse/mesh.example.test.signing.key"
printf 'log fixture\n' \
  > "$backup_tool/runtime/synapse/mesh.example.test.log.config"
printf 'media fixture\n' \
  > "$backup_tool/runtime/synapse/media_store/local_content/object"
cat > "$backup_tool/fake-bin/docker" <<'EOF'
#!/bin/sh
case "$*" in
  *" pg_dump "*)
    case "$*" in
      *" --exclude-table-data e2e_one_time_keys_json"*) ;;
      *)
        echo "backup.sh did not exclude e2e_one_time_keys_json data." >&2
        exit 1
        ;;
    esac
    printf 'partial custom-format database dump\n'
    if [ "${FAKE_DOCKER_FAIL_DUMP:-0}" = "1" ]; then
      exit 1
    fi
    ;;
  *" pg_restore --list")
    cat >/dev/null
    ;;
  *)
    echo "Unexpected fake Docker invocation: $*" >&2
    exit 1
    ;;
esac
EOF
chmod 700 "$backup_tool/fake-bin/docker"

if (
  cd "$backup_tool"
  PATH="$backup_tool/fake-bin:$PATH" FAKE_DOCKER_FAIL_DUMP=1 \
    sh ./backup.sh >/dev/null 2>&1
); then
  echo "backup.sh accepted a failed PostgreSQL dump." >&2
  exit 1
fi
if find "$backup_tool/runtime/backups" -mindepth 1 -maxdepth 1 \
  \( -name '.*.partial.*' -o -name '.backup.lock' \) |
  grep -q .
then
  echo "backup.sh left partial state after failure." >&2
  exit 1
fi

backup_path="$(
  cd "$backup_tool"
  PATH="$backup_tool/fake-bin:$PATH" sh ./backup.sh 2>/dev/null
)"
test -d "$backup_path"
test -s "$backup_path/manifest.sha256"
test -s "$backup_tool/runtime/status/local-backup-status.json"
test -s "$backup_path/backup-metadata.env"
if [ -e "$backup_path/operator.env" ] ||
   grep -Eq '^(POSTGRES_PASSWORD|REGISTRATION_SHARED_SECRET|MACAROON_SECRET_KEY|FORM_SECRET)=' \
     "$backup_path/backup-metadata.env"
then
  echo "backup.sh published the plaintext operator environment." >&2
  exit 1
fi
sh "$backup_tool/verify-backup.sh" "$backup_path" >/dev/null

retention_root="$test_root/retention"
mkdir -p \
  "$retention_root/20260729T120000Z" \
  "$retention_root/20260728T120000Z" \
  "$retention_root/20260720T120000Z" \
  "$retention_root/20260713T120000Z"
# shellcheck source=infra/homeserver/backup-lib.sh
. "$homeserver_dir/backup-lib.sh"
if printf '%s\n' '1; TABLE DATA public e2e_one_time_keys_json synapse' |
   assert_no_otk_table_data >/dev/null 2>&1
then
  echo "backup restore guard accepted OTK table data." >&2
  exit 1
fi
prune_local_backups \
  "$retention_root" \
  "$retention_root/20260729T120000Z" \
  2 \
  2
test -d "$retention_root/20260729T120000Z"
test -d "$retention_root/20260728T120000Z"
test -d "$retention_root/20260720T120000Z"
if [ -e "$retention_root/20260713T120000Z" ]; then
  echo "local backup retention did not prune an expired weekly slot." >&2
  exit 1
fi

offsite_tool="$test_root/offsite-tool"
mkdir -p "$offsite_tool/fake-bin" "$offsite_tool/runtime"
cp "$homeserver_dir/backup.sh" \
  "$homeserver_dir/backup-lib.sh" \
  "$homeserver_dir/offsite-backup.sh" \
  "$homeserver_dir/verify-backup.sh" \
  "$offsite_tool/"
cp "$backup_tool/.env" "$offsite_tool/.env"
cp "$backup_tool/fake-bin/docker" "$offsite_tool/fake-bin/docker"
cp -R "$backup_tool/runtime/synapse" "$offsite_tool/runtime/synapse"
cat > "$offsite_tool/fake-bin/restic" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$RESTIC_CALL_LOG"
case "$1" in
  backup|snapshots|check)
    exit 0
    ;;
  forget)
    case "$*" in
      *"--prune"*"--keep-daily 2"*"--keep-weekly 1"*) exit 0 ;;
      *) echo "restic forget did not receive the configured retention policy." >&2; exit 1 ;;
    esac
    ;;
  *)
    echo "Unexpected fake restic invocation: $*" >&2
    exit 1
    ;;
esac
EOF
chmod 700 "$offsite_tool/fake-bin/restic"
restic_call_log="$test_root/restic-calls.log"
(
  cd "$offsite_tool"
  PATH="$offsite_tool/fake-bin:$PATH" \
    RESTIC_CALL_LOG="$restic_call_log" \
    RESTIC_REPOSITORY='test:mesh' \
    RESTIC_PASSWORD='unit-test-restic' \
    MESH_OFFSITE_BACKUP_KEEP_DAILY=2 \
    MESH_OFFSITE_BACKUP_KEEP_WEEKLY=1 \
    sh ./offsite-backup.sh >/dev/null
)
grep -F -- '--prune' "$restic_call_log" >/dev/null
grep -F -- '--keep-daily 2' "$restic_call_log" >/dev/null
grep -F -- '--keep-weekly 1' "$restic_call_log" >/dev/null

echo "Homeserver backup integrity regression tests passed."
