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
      operator.env \
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
  cat > "$fixture/operator.env" <<'EOF'
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
rm "$missing_fixture/operator.env"
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

placeholder_fixture="$test_root/placeholder"
cp -R "$valid_fixture" "$placeholder_fixture"
sed 's/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=REPLACE_WITH_RANDOM_SECRET/' \
  "$placeholder_fixture/operator.env" > "$placeholder_fixture/operator.next"
mv "$placeholder_fixture/operator.next" "$placeholder_fixture/operator.env"
write_manifest "$placeholder_fixture"
if sh "$homeserver_dir/verify-backup.sh" "$placeholder_fixture" >/dev/null 2>&1; then
  echo "verify-backup accepted placeholder recovery secrets." >&2
  exit 1
fi

symlink_fixture="$test_root/symlink"
cp -R "$valid_fixture" "$symlink_fixture"
rm "$symlink_fixture/postgres.dump"
ln -s "$valid_fixture/postgres.dump" "$symlink_fixture/postgres.dump"
if sh "$homeserver_dir/verify-backup.sh" "$symlink_fixture" >/dev/null 2>&1; then
  echo "verify-backup accepted a symbolic-link recovery file." >&2
  exit 1
fi

backup_tool="$test_root/backup-tool"
mkdir -p \
  "$backup_tool/fake-bin" \
  "$backup_tool/runtime/synapse/media_store/local_content"
cp "$homeserver_dir/backup.sh" "$homeserver_dir/verify-backup.sh" "$backup_tool/"
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
sh "$backup_tool/verify-backup.sh" "$backup_path" >/dev/null

echo "Homeserver backup integrity regression tests passed."
