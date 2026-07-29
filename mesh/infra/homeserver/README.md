# Mesh homeserver runbook

This stack runs the managed Mesh Matrix service on the Mac mini:

- Synapse for accounts, rooms, messages, encryption metadata, and federation;
- PostgreSQL for durable state;
- Caddy for public HTTPS and Matrix discovery after DNS/router activation.

The permanent Matrix server name is `mesh.dhawal.org`. User IDs will look like
`@name:mesh.dhawal.org`.

## Local setup

```sh
cd mesh/infra/homeserver
./setup.sh
./start.sh
./status.sh
./backup.sh
```

The local Synapse control port binds only to `127.0.0.1:8008`. Registration is
closed by default. Create alpha accounts with `register_new_matrix_user` after
the service is healthy.

The initial operator account is `@dhawal:mesh.dhawal.org`. Its generated
password is stored in macOS Keychain and can be retrieved locally with:

```sh
security find-generic-password \
  -a '@dhawal:mesh.dhawal.org' \
  -s 'Mesh Homeserver Admin' \
  -w
```

The installed `org.mesh.homeserver` user LaunchAgent opens Docker after login.
Docker's `unless-stopped` policy then restarts the Mesh services. The
`org.mesh.homeserver.backup` LaunchAgent makes a local backup daily at 3:15 AM
under `~/Library/Application Support/Mesh/backups`. Copy those backups to a
separate disk before treating the service as durable. The scheduled local
copies are retained for 14 days.

The `org.mesh.homeserver.ddns` LaunchAgent checks the public IPv4 address every
five minutes and updates only the `mesh.dhawal.org` Cloudflare A record when it
changes. Its restricted API token is stored in macOS Keychain under
`Mesh Cloudflare DDNS API Token`.

## Public activation

Do not start the public profile until all of these are true:

1. In Cloudflare DNS, add a DNS-only `A` record named `mesh` pointing to the
   home connection's public IPv4 address.
2. Add a DNS-only `CNAME` named `matrix.mesh` targeting `mesh.dhawal.org`.
3. Reserve the Mac's Ethernet address in the router, then forward TCP 80,
   TCP 443, and UDP 443 to it.
4. Enable the macOS firewall and allow Docker's incoming listener.
5. If the public IP is not static, configure a Cloudflare dynamic-DNS updater.
6. Confirm that the local stack and a backup restore have passed validation.

Then start the proxy:

```sh
sed -i '' 's/MESH_PUBLIC_ENABLED=0/MESH_PUBLIC_ENABLED=1/' .env
./start.sh
```

Verify from a device that is not on the home Wi-Fi:

```sh
curl https://mesh.dhawal.org/.well-known/matrix/client
curl https://matrix.mesh.dhawal.org/_matrix/client/versions
```

The MatrixRTC stack under `../matrixrtc` is activated separately after the
homeserver is publicly healthy.

## Critical data

Never lose:

- the PostgreSQL database;
- `runtime/synapse/mesh.dhawal.org.signing.key`;
- the local media store;
- the untracked `.env` operator secrets.

The server name and signing key identify the homeserver in federation. Backups
must eventually be copied off this Mac and restore-tested.

If operator secrets are exposed, rotate the PostgreSQL password and Synapse
runtime secrets without changing the server name or signing key:

```sh
./rotate-runtime-secrets.sh
```
