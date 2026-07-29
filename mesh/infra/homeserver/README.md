# Mesh homeserver runbook

This stack runs the managed Mesh Matrix service on the Mac mini:

- Synapse for accounts, rooms, messages, encryption metadata, and federation;
- PostgreSQL for durable state;
- the Mesh admission service for bounded, one-use community links;
- Caddy for public HTTPS and Matrix discovery after DNS/router activation.

The permanent Matrix server name is `mesh.dhawal.org`. User IDs will look like
`@name:mesh.dhawal.org`.

## Local setup

```sh
cd mesh/infra/homeserver
./setup.sh
./start.sh
./status.sh
sh ./backup.sh
```

The local Synapse control port binds only to `127.0.0.1:8008`. Public account
creation is enabled only through bounded registration invitations. Open,
unverified registration remains disabled. The admission service is the only
public route that can mint those registrations; it stores only invitation
digests, uses a dedicated service administrator, and never exposes Synapse's
administrative API through Caddy.

On first start, Mesh creates the operator account
`@dhawal:mesh.dhawal.org` and stores its generated password in macOS Keychain.
Retrieve it locally with:

```sh
security find-generic-password \
  -a '@dhawal:mesh.dhawal.org' \
  -s 'Mesh Homeserver Admin' \
  -w
```

Community administrators create a one-use invitation from Mesh's **Invite**
dialog. The link expires after seven days. Opening it launches Mesh, carries
the user through account creation or sign-in, sends standard Matrix invites
from the original administrator for the community and its private rooms, and
joins without another approval click.

`start.sh` creates the dedicated `@mesh-admission-service:mesh.dhawal.org`
account and rotates its local access token when the saved token is invalid.
The token and the HMAC key used to derive registration admissions remain only
in the untracked, mode-`600` `.env` file.

The following operator command remains available for account-only recovery
and testing; it does not grant entry to a community:

```sh
sh ./create-registration-invite.sh
```

Optional arguments set expiry days and allowed uses:

```sh
sh ./create-registration-invite.sh 2 1
```

Never use an unlimited or non-expiring registration token for public
onboarding.

The installed `org.mesh.homeserver` user LaunchAgent opens Docker after login.
Docker's `unless-stopped` policy then restarts the Mesh services.

The `org.mesh.homeserver.ddns` LaunchAgent checks the public IPv4 address every
five minutes and updates only the `mesh.dhawal.org` Cloudflare A record when it
changes. Its restricted API token is stored in macOS Keychain under
`Mesh Cloudflare DDNS API Token`.

## Backups, monitoring, and restoration

`backup.sh` makes an atomic, integrity-manifested local recovery point. It
contains the PostgreSQL dump, stable signing identity, Synapse configuration,
media store, and matching runtime secrets. The script validates the dump
catalog and every manifest hash before publishing the timestamped directory.
Incomplete backups stay hidden as `.partial` directories and are removed on
failure.

The raw local recovery point contains secrets. Keep FileVault enabled, keep the
directory private, and never copy it directly to cloud storage. The supported
offsite path is restic, which provides authenticated encryption:

```sh
# Inject these from macOS Keychain or another operator secret store.
export RESTIC_REPOSITORY='s3:s3.us-west-000.backblazeb2.com/mesh-production'
export RESTIC_PASSWORD_COMMAND='security find-generic-password -s "Mesh Restic Password" -w'
export AWS_ACCESS_KEY_ID='...'
export AWS_SECRET_ACCESS_KEY='...'

sh ./offsite-backup.sh
```

Run `offsite-backup.sh` daily from the backup LaunchAgent. It first creates and
validates a new local backup, uploads it, confirms a tagged snapshot exists,
and performs a sampled repository data check. It writes non-secret local and
offsite status records under `runtime/status`. Do not configure automatic
pruning until the retention owner and legal requirements are finalized.

At least monthly, restore the newest backup into isolated Docker resources:

```sh
sh ./restore-drill.sh
```

The drill verifies every file, restores PostgreSQL into a disposable volume,
checks required Synapse tables, boots the restored homeserver on an isolated
network, and calls its health and client-version endpoints. Production
containers, ports, and data are never reused. A successful drill writes
`runtime/status/restore-drill-status.json`.

The monitoring probe fails unless both containers are healthy, local and
offsite backups are newer than 26 hours, the restore drill is newer than 31
days, both local Matrix endpoints respond, and at least 15% of the data disk
is free:

```sh
sh ./operational-health.sh
```

Schedule that probe every five minutes and alert from a different machine or
provider. A monitor running only on the homeserver cannot report host, power,
or network loss. The operator smoke test remains the public, outside-network
acceptance gate.

For a real loss, retrieve a restic snapshot, run `verify-backup.sh`, and use a
fresh checkout on the replacement host:

```sh
sh ./verify-backup.sh /private/recovery/20260729T120000Z
sh ./restore-new-host.sh /private/recovery/20260729T120000Z
```

`restore-new-host.sh` refuses to run if `.env`, PostgreSQL, or Synapse state
already exists. It restores only into a clean deployment, keeps public traffic
and calling disabled, restores the database, and requires Synapse to become
healthy. DNS or load-balancer cutover is always a separate operator action.

## Public activation

Do not start the public profile until all of these are true:

1. In Cloudflare DNS, add a DNS-only `A` record named `mesh` pointing to the
   home connection's public IPv4 address.
2. Add a DNS-only `CNAME` named `matrix.mesh` targeting `mesh.dhawal.org`.
3. Reserve the Mac's Ethernet address in the router, then forward TCP 80,
   TCP 443, and UDP 443 to it.
4. Enable the macOS firewall and allow Docker's incoming listener.
5. If the public IP is not static, configure a Cloudflare dynamic-DNS updater.
6. Confirm that the local stack, encrypted offsite backup, external monitor,
   and isolated restore drill have passed validation.

Then start the proxy:

```sh
sed -i '' 's/MESH_PUBLIC_ENABLED=0/MESH_PUBLIC_ENABLED=1/' .env
./start.sh
```

Verify from a device that is not on the home Wi-Fi:

```sh
curl https://mesh.dhawal.org/.well-known/matrix/client
curl https://mesh.dhawal.org/_mesh/admission/healthz
curl https://matrix.mesh.dhawal.org/_matrix/client/versions
```

Both commands must succeed repeatedly, not just once. Intermittent TCP
timeouts mean the router forwarding, Mac sleep/power state, Docker listener,
or firewall is still unhealthy.

The MatrixRTC stack under `../matrixrtc` is activated separately after the
homeserver is publicly healthy. `MESH_RTC_ENABLED` must remain `0` until RTC
DNS, TLS, authorization, SFU signalling, TURN allocation, and a real encrypted
two-party call pass. After they pass, set it to `1`, rerun `./setup.sh`, and
restart the public proxy. This prevents discovery from advertising a calling
service that does not exist.

## Critical data

Never lose:

- the PostgreSQL database;
- `runtime/synapse/mesh.dhawal.org.signing.key`;
- the local media store;
- the untracked `.env` operator secrets.

The server name and signing key identify the homeserver in federation. Backups
must be encrypted off this Mac and restore-tested on the documented schedule.

This repository supplies a recoverable single-node deployment. It does not
make one Mac, one ISP connection, or one PostgreSQL instance highly available.
Before release, provision at least two failure-independent service nodes (or a
managed equivalent), replicated PostgreSQL and media, external health alerts,
and a tested traffic failover. Record the provider, failure domains, RPO, RTO,
retention, and dated restore/failover evidence. Until those live checks pass,
the managed service remains a release blocker.

If operator secrets are exposed, rotate the PostgreSQL password and Synapse
runtime secrets without changing the server name or signing key:

```sh
./rotate-runtime-secrets.sh
```
