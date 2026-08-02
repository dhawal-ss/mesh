#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$script_dir"
umask 077

if [ ! -f .env ]; then
  echo "Missing .env. Run ./setup.sh first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"

new_postgres_password="$(openssl rand -hex 32)"
new_admission_db_password="$(openssl rand -hex 32)"
new_registration_secret="$(openssl rand -hex 32)"
new_macaroon_secret="$(openssl rand -hex 32)"
new_form_secret="$(openssl rand -hex 32)"

printf "ALTER ROLE %s PASSWORD '%s';\n" \
  "$POSTGRES_USER" \
  "$new_postgres_password" \
  | docker compose exec -T postgres \
      psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" >/dev/null

next_env="$(mktemp "$script_dir/.env.next.XXXXXX")"
awk \
  -v postgres="$new_postgres_password" \
  -v admission_db="$new_admission_db_password" \
  -v registration="$new_registration_secret" \
  -v macaroon="$new_macaroon_secret" \
  -v form="$new_form_secret" \
  '
  /^POSTGRES_PASSWORD=/ { print "POSTGRES_PASSWORD=" postgres; next }
  /^MESH_ADMISSION_DB_PASSWORD=/ { print "MESH_ADMISSION_DB_PASSWORD=" admission_db; next }
  /^REGISTRATION_SHARED_SECRET=/ { print "REGISTRATION_SHARED_SECRET=" registration; next }
  /^MACAROON_SECRET_KEY=/ { print "MACAROON_SECRET_KEY=" macaroon; next }
  /^FORM_SECRET=/ { print "FORM_SECRET=" form; next }
  { print }
  ' .env > "$next_env"
chmod 600 "$next_env"
mv "$next_env" .env

unset \
  new_postgres_password \
  new_admission_db_password \
  new_registration_secret \
  new_macaroon_secret \
  new_form_secret

./setup.sh >/dev/null
./start.sh >/dev/null

echo "Homeserver runtime secrets rotated successfully."
