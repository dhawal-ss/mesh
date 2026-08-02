# Optional community-hosted Matrix service

This directory is a reference deployment for a community owner who chooses to
host Matrix on a Mac mini or another Docker host. It is not required to use
Mesh, is not a Mesh-operated public account service, and has no uptime SLA.
Members may keep accounts on Matrix.org or any compatible service and join the
community through federation.

The stack contains Synapse, PostgreSQL, a bounded one-use invitation service,
and Caddy. Public registration is never open: account creation is either
disabled or requires an operator-issued registration token.

Synapse is pinned to the reviewed multi-architecture ``v1.157.1`` image index
digest in Compose, setup, and restore tooling. Treat every version change as an
operator upgrade: review the upstream release notes, back up first, run the
daemon-free configuration and admission tests, then complete two independent
disposable federation cycles before changing a live service. Never replace the
digest with ``latest`` or infer live safety from a successful image pull.

## Permanent identity decision

Choose the Matrix server name before creating the first account. It becomes
part of every user, room, and event ID and must survive a host migration. Back
up its signing key with the database and media; changing only DNS cannot replace
a lost signing identity.

Example first setup:

```sh
cd mesh/infra/homeserver
export MESH_SERVER_NAME='community.example'
export MESH_HOMESERVER_HOST='matrix.community.example'
export MESH_ABUSE_EMAIL='abuse@community.example'
export ACME_EMAIL='admin@community.example'
./setup.sh
./start.sh
./status.sh
```

`setup.sh` refuses to invent a public identity. It generates untracked secrets
in mode-`600` `.env`, binds Synapse's control port to `127.0.0.1`, and keeps the
public Caddy profile disabled until the operator explicitly activates it.

The operator account password is stored in macOS Keychain. Retrieve it locally:

```sh
security find-generic-password \
  -a "@operator:${MESH_SERVER_NAME}" \
  -s 'Mesh Homeserver Admin' \
  -w
```

The actual account name is controlled by `start.sh`; inspect its first-run
output before relying on this example.

## Account creation and emergency shutdown

`MESH_REGISTRATION_ENABLED=1` permits token-gated account creation only.
`enable_registration_without_verification` remains false and
`registration_requires_token` remains true. The community invitation service
stores only opaque invitation/proof digests. It runs as the dedicated non-admin
`MESH_ADMISSION_SERVICE_USER_ID`; its token has only the membership and power
that each community explicitly gives that account. Never make it a Synapse
server administrator.

Production invitation creation and claim currently fail closed. A deployment
must first provide both a reviewed POST-capable Matrix OpenID verifier and a
narrowly scoped registration-token issuer. Stock Synapse validates OpenID
proofs through a credential-bearing query URL and manages registration tokens
through its server-admin API, so the reference service deliberately implements
neither unsafe fallback. Replay state is keyed to the issuing server, verified
user, and credential itself, so changing a client-supplied proof UUID, purpose,
subject, or audience does not make a token reusable. The exact proof, replay,
SSRF, bot-membership, and
moderation-audit boundaries are documented in
`docs/security/PHASE1_NATIVE_SECURITY_BOUNDARIES.md`. A person who chooses
another account service never sends an account credential or registration
token to this community service.

Close account creation immediately without disabling existing accounts:

```sh
sh ./registration-control.sh close
```

Reopening is an explicit operator decision:

```sh
sh ./registration-control.sh open
```

For account-only recovery and testing, `sh ./create-registration-invite.sh 2 1`
creates a token with a two-day expiry and one allowed use. It does not grant
community membership. Never issue unlimited or non-expiring public tokens.

## Bounded service policy

`configure_synapse.py` sets explicit limits for login attempts, registration,
messages, joins, invites, federation concurrency, and uploads. Uploads are
limited to 100 MB each; remote cached media expires after 30 days. Automatic
message deletion is disabled, so the community operator must publish any later
retention change before applying it to existing rooms.

Stock Synapse does not provide the per-user storage quota required for an
unattended public service. Until a reviewed quota mechanism and alert exist,
operators must monitor disk growth, limit admissions, and treat disk pressure
as a reason to close registration. `operational-health.sh` fails below 15% free
space. This is a known limitation, not an implied unlimited-storage promise.

The operator must keep `MESH_ABUSE_EMAIL` current and publish it with the
community's rules. The reference configuration sends no usage statistics,
disables URL previews, guest access, unauthenticated public-room listing, and
public Synapse admin routes.

## Backups and restore evidence

`backup.sh` makes an atomic recovery point containing:

- a validated PostgreSQL dump with `e2e_one_time_keys_json` table data
  excluded;
- the stable Matrix signing key and Synapse configuration;
- the media store;
- non-secret recovery metadata and a hash manifest.

The standalone `.env` operator file and admission credentials are deliberately
not copied into backup content. The Synapse configuration and stable signing
key are still sensitive recovery material, so keep FileVault enabled locally
and use the authenticated-encryption restic path offsite. Keep the complete
operator environment in macOS Keychain or another operator-controlled secret
store, and reconstruct a mode-`600` recovery file only when a new host is
ready. For example, with one Keychain item per variable under the service
`Mesh Homeserver Runtime`:

```sh
umask 077
recovery_env="$HOME/.config/mesh/homeserver-recovery.env"
mkdir -p "$(dirname "$recovery_env")"
: > "$recovery_env"
for key in \
  MESH_SERVER_NAME MESH_HOMESERVER_HOST MESH_RTC_HOST MESH_RTC_ENABLED \
  MESH_PUBLIC_ENABLED MESH_REGISTRATION_ENABLED MESH_ABUSE_EMAIL \
  MESH_OPERATOR_LOCALPART POSTGRES_USER POSTGRES_DB POSTGRES_PASSWORD \
  REGISTRATION_SHARED_SECRET MACAROON_SECRET_KEY FORM_SECRET \
  MESH_ADMISSION_SIGNING_KEY MESH_ADMISSION_SERVICE_USER_ID +  MESH_ADMISSION_SERVICE_ACCESS_TOKEN ACME_EMAIL
do
  printf '%s=%s\n' "$key" \
    "$(security find-generic-password -a "$key" -s 'Mesh Homeserver Runtime' -w)" \
    >> "$recovery_env"
done
chmod 600 "$recovery_env"
```

The exact secret-store retrieval process is an owner responsibility; never
put the reconstructed file under `runtime/backups/`.

Local retention keeps the newest seven calendar days and four additional
calendar weeks by default. Override with `MESH_LOCAL_BACKUP_KEEP_DAILY` and
`MESH_LOCAL_BACKUP_KEEP_WEEKLY`. The encrypted restic path applies a separate
default of 30 daily and 12 weekly snapshots, then runs `restic forget --prune`:

```sh
export RESTIC_REPOSITORY='s3:s3.example.invalid/community-matrix'
export RESTIC_PASSWORD_COMMAND='security find-generic-password -s "Mesh Restic Password" -w'
export MESH_OFFSITE_BACKUP_KEEP_DAILY=30
export MESH_OFFSITE_BACKUP_KEEP_WEEKLY=12
export AWS_ACCESS_KEY_ID='...'
export AWS_SECRET_ACCESS_KEY='...'
sh ./offsite-backup.sh
```

Install and edit
`launchd/com.mesh.homeserver.offsite-backup.plist` for the actual checkout
path, then load it as a per-user LaunchAgent:

```sh
launchctl bootstrap "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/com.mesh.homeserver.offsite-backup.plist"
```

The documented cron equivalent is:

```cron
0 2 * * * cd /absolute/path/to/mesh/infra/homeserver && RESTIC_REPOSITORY='s3:s3.example.invalid/community-matrix' RESTIC_PASSWORD_COMMAND='security find-generic-password -s "Mesh Restic Password" -w' /bin/sh ./offsite-backup.sh >> runtime/logs/offsite-backup.log 2>&1
```

Schedule `sh ./restore-drill.sh` at least quarterly. The drill uses isolated
Docker resources, validates the manifest and database, requires the restore
password through `MESH_RESTORE_POSTGRES_PASSWORD`, starts the restored server
without public traffic, and writes dated evidence to
`runtime/status/restore-drill-status.json`. The operational health check
requires each successful status file to contain a `lastSuccessfulAt` value.

For a real loss, restore onto a clean host:

```sh
sh ./verify-backup.sh /private/recovery/20260729T120000Z
MESH_RECOVERY_OPERATOR_ENV="$HOME/.config/mesh/homeserver-recovery.env" \
MESH_CONFIRM_FEDERATED_RESTORE=I_UNDERSTAND_DATABASE_ROLLBACK_IS_DESTRUCTIVE \
  sh ./restore-new-host.sh /private/recovery/20260729T120000Z
```

`restore-new-host.sh` refuses an existing `.env`, PostgreSQL directory, or
Synapse state. It also refuses to run without an explicit federated-restore
confirmation. Rolling a federated homeserver database backwards is destructive:
newer events can be invalidated, and the stable signing key must never be
regenerated. If a signing key is retired, preserve its public key in
`old_signing_keys` before changing identity. DNS/router cutover remains a
separate owner action.

## Public activation checklist

Do not enable the public profile until the owner has:

1. created DNS for the permanent server name and homeserver host;
2. reserved the host on the router and forwarded TCP 80/443 and UDP 443;
3. enabled the host firewall and prevented sleep during service hours;
4. configured dynamic DNS when the address is not static;
5. completed an encrypted off-host backup and isolated restore drill;
6. configured monitoring from another network and the abuse contact;
7. tested inbound and outbound federation with a disposable external account.

Then set `MESH_PUBLIC_ENABLED=1` in `.env`, run `./start.sh`, and verify from a
device outside the home network:

```sh
curl "https://${MESH_SERVER_NAME}/.well-known/matrix/client"
curl "https://${MESH_SERVER_NAME}/_mesh/admission/healthz"
curl "https://${MESH_HOMESERVER_HOST}/_matrix/client/versions"
```

Repeat after router restart, host restart, and a dynamic-IP change. A one-time
success is not recovery evidence.

## Federation troubleshooting and migration

For failed joins, check DNS and TLS for both public names, `.well-known`
responses, Synapse federation logs, room join rules, and the invitation's
`via` servers. Test from an outside network. Never fix federation by moving the
member's account to this homeserver.

A migration must preserve:

- `MESH_SERVER_NAME`;
- the signing key;
- PostgreSQL;
- the media store;
- Synapse configuration and matching runtime secrets.

Restore these on the new host with public traffic disabled, validate locally,
then move DNS while retaining the same server name. Document the date, outage,
backup snapshot, restore result, and rollback path.

MatrixRTC is separate and remains disabled until its own trusted-focus,
TURN/TLS, media-E2EE, physical-device, and two-network acceptance passes. Text
chat and membership must continue to work without voice.

This reference deployment is recoverable single-node infrastructure, not high
availability. The owner must disclose maintenance and outages honestly; Mesh's
consumer onboarding must never present it as the universal default.
