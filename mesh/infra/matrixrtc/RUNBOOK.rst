Mesh MatrixRTC single-node operator runbook
===========================================

Scope and product boundary
--------------------------

This stack is an optional community-hosted/BYOH calling service with no uptime
SLA. Mesh must continue to work for text and community use when this stack is
absent. It is never a universal Mesh service and it must not select or create a
person's account service. Account hosting, community room routing, and any
optional admission service remain separate.

Keep MESH_RTC_ENABLED=0 and omit RTC discovery until the exact deployment has
passed configuration, online, physical-device, network, encryption, revocation,
and reconnect acceptance. Never fall back to legacy peer-to-peer media when
discovery or acceptance is incomplete.

Pinned services and public boundaries
-------------------------------------

- LiveKit is pinned in docker-compose.yml by version and OCI digest.
- The MatrixRTC authorization service is pinned by version and OCI digest.
- TLS terminates in the reviewed reverse proxy. The authorization and LiveKit
  control ports, metrics, and the plaintext hop behind TURN/TLS stay loopback
  only. The signed SFU webhook is private to the Compose network.
- Only /livekit/jwt/ and /livekit/sfu/ are public. Do not expose dashboards,
  admin APIs, metrics, webhook receivers, or operator status endpoints.
- Publish org.matrix.msc4143.rtc_foci only on the Matrix server name that is
  intentionally offering this calling service. That discovery does not change
  where a person's account lives or where a community is routed.

Required operator configuration
-------------------------------

Store the real environment file outside the repository with owner-only
permissions. The tracked .env.example contains placeholders and is never a
deployable secret file.

Public/non-secret settings:

- MATRIXRTC_CONTROL_BIND
- MATRIXRTC_METRICS_BIND
- MATRIXRTC_TURN_TLS_BIND
- MATRIXRTC_MATRIX_SERVER_NAME
- MESH_MATRIXRTC_LIVEKIT_SERVICE_URL
- MESH_MATRIXRTC_LIVEKIT_SFU_URL
- MATRIXRTC_FULL_ACCESS_HOMESERVERS
- LIVEKIT_TURN_DOMAIN

Secrets:

- LIVEKIT_API_KEY
- LIVEKIT_API_SECRET

The key and secret are a pair shared only by LiveKit and the authorization
service. Never place them in source, client configuration, logs, command-line
arguments, support bundles, acceptance evidence, or public monitoring. Use an
operator-owned secret store and inject them into the Compose environment.

DNS, TLS, and firewall prerequisites
------------------------------------

- ``matrix-rtc.<community-domain>`` and ``LIVEKIT_TURN_DOMAIN`` must be separate
  DNS hostnames with reviewed A/AAAA records for the deployed host. Remove stale
  records before advertising discovery. Check both with ``Resolve-DnsName`` (or
  the platform DNS equivalent) from each acceptance network.
- The HTTPS/WSS certificate must cover the MatrixRTC service hostname. The
  TURN-over-TLS certificate must independently cover ``LIVEKIT_TURN_DOMAIN``.
  Require a currently trusted TLS 1.2 or TLS 1.3 chain; never bypass hostname or
  certificate validation.
- Allow inbound TCP 443 for authorization/signalling, TCP 7881 for LiveKit's
  ICE/TCP fallback, UDP 3478 for TURN/UDP, TCP 5349 at the trusted TURN/TLS
  terminator, and UDP 50000-50100 for bounded RTP media. Keep TCP 7880/8080,
  TCP 6789 metrics, and the plaintext TCP 5349 hop loopback-only. Deny every
  other container/control port at the host and perimeter firewall.
- Verify TCP 443 and TCP 5349 from both acceptance networks with
  ``Test-NetConnection`` (or an equivalent trusted-TLS probe). A successful TCP
  connection alone is not TURN evidence: the credentialed operator smoke and
  the ``turn_probe_live_tests`` allocation must also prove UDP and TURN/TLS
  relay paths.
- Keep host, reverse-proxy, LiveKit, authorization, and TURN/TLS logs bounded by
  size and retention. Use the query-redacting format in
  ``nginx.example.conf`` and never enable packet or media capture by default.

Fresh non-production start
--------------------------

1. Copy .env.example to an operator-only path outside the checkout. Replace all
   placeholders, set owner-only permissions, and keep calling discovery off.
2. Render and validate without starting services:

   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/matrixrtc-preflight.ps1 -Production -EnvironmentFile X:\operator\matrixrtc.env -WellKnownFile X:\operator\matrix-client.json

3. From infra/matrixrtc, start the pinned stack with the external environment:

   docker compose --env-file X:\operator\matrixrtc.env up -d

4. Require matrixrtc-auth to become healthy. Confirm LiveKit signalling rejects
   a tokenless upgrade, the public authorization health endpoint uses trusted
   TLS, and discovery returns the exact authorization URL:

   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/matrixrtc-preflight.ps1 -Production -Online -EnvironmentFile X:\operator\matrixrtc.env -WellKnownFile X:\operator\matrix-client.json

5. Run the credentialed operator smoke with secrets injected only through the
   process environment. It verifies account identity, encrypted sync, Matrix
   media, authenticated MatrixRTC token exchange, SFU signalling, TURN
   allocation, backup freshness, and monitoring liveness:

   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/operator-smoke.ps1 -Production -Online -EnvironmentFile X:\operator\operator-smoke.env

6. Complete acceptance-matrix.example.json on two physical devices and the
   required networks. Copy the template to an operator-owned location and
   create a separate evidence root outside the Git worktree. Keep every
   referenced artifact below that root. Validate the manifest and artifacts
   against the exact clean source SHA:

   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/matrixrtc-preflight.ps1 -Production -Online -RequireLiveAcceptance -EnvironmentFile X:\operator\matrixrtc.env -WellKnownFile X:\operator\matrix-client.json -AcceptanceEvidenceFile X:\operator\matrixrtc-acceptance.json -EvidenceRoot X:\operator\matrixrtc-evidence

Evidence artifact and redaction contract
----------------------------------------

Live acceptance is valid only from a clean tracked and untracked worktree. The
sourceSha, signed client-build provenance, and client-build artifact must all
bind to the same Git HEAD. Do not generate live evidence inside the source
tree. Each artifact entry uses a stable evidence ID, a relative path below the
explicit evidence root, SHA-256, exact byte size, media type, capture timestamp,
kind, one exact ``caseId`` (except the global signed client build), and a
sanitized description. Each completed test case names the registered
``deviceIds`` and ``networkIds``, records the observed ``transport``, attests
``mediaE2eeActive``, and attaches a case-bound service log, client diagnostic,
and network result. The key-rotation case must additionally attest
``mediaE2eeFailureClosed``. Test cases reference evidence IDs; generic or
cross-case artifacts and arbitrary prose paths are not accepted.

The validator resolves both the evidence root and artifact paths canonically.
It rejects absolute paths, traversal, symlink escape, missing or changed files,
duplicate IDs or files, unknown references, unused artifacts, stale/future
timestamps, placeholder metadata, incomplete cases, and unbound client builds.
Only ``windows-plus-supported-client`` may be ``not-applicable``, and it needs a
specific non-placeholder reason.

Redact before hashing. Evidence must be content-free and must not contain
access or refresh tokens, JWTs, authorization headers, TURN usernames or
credentials, LiveKit API credentials, Matrix account IDs, room IDs, room names,
message text, media payloads, personal contact data, local absolute paths, or
secret-bearing URLs. Screenshots must crop or mask notifications, account
identifiers, contacts, room names, messages, and unrelated applications.
Packet/network results may record protocols, relay/direct outcome, timing,
loss, and endpoint roles, but never credentials or media. Keep the original
evidence root read-only after the manifest passes and retain it according to
the operator's reviewed evidence-retention policy.

Do not enable discovery merely because containers are healthy. Health and
signalling checks do not prove TURN relaying, media encryption, membership
revocation, key rotation, reconnect, or physical device behavior.

Restart exercise
----------------

Run this first in isolated non-production infrastructure with test accounts and
no real user data:

1. Record the source SHA, pinned image digests, public configuration, certificate
   fingerprints, and current sanitized health results.
2. Start a test call, end it, and confirm no participant remains in LiveKit or
   Matrix call membership.
3. Restart the stack:

   docker compose --env-file X:\operator\matrixrtc.env restart

4. Repeat the online preflight, operator smoke, and a two-device encrypted call.
   Confirm the authorization service does not widen the homeserver allowlist,
   auto-create arbitrary rooms, retain ghost participants, or accept an old or
   wrong-room token.
5. Record expected versus actual results, restart duration, content-free service
   logs, and sanitized client diagnostics in the acceptance evidence.

The reference stack is intentionally stateless beyond live sessions. A restart
interrupts calls; it must not silently broaden access or persist credentials.

Credential rotation exercise
----------------------------

Rotation invalidates current SFU/API credentials and may interrupt calls.
Announce the non-production maintenance window and verify that no production
traffic is pointed at the exercise.

1. Generate a new independent key/secret pair in the operator secret store.
   Keep the previous pair available only for the bounded rollback window.
2. Atomically replace LIVEKIT_API_KEY and LIVEKIT_API_SECRET in the external
   environment. Do not print either value.
3. Recreate both services together so they cannot disagree about the pair:

   docker compose --env-file X:\operator\matrixrtc.env up -d --force-recreate matrixrtc-auth livekit

4. Repeat online preflight, authenticated token exchange, a two-device encrypted
   call, participant leave, and a forced TURN call. Verify an artifact or token
   from before rotation is rejected.
5. If verification fails, restore the previous pair from the secret store,
   recreate both services with --force-recreate, keep discovery disabled, and
   investigate before retrying. Destroy the failed new pair.
6. When verification passes, destroy the previous pair and record only the
   rotation timestamp, responsible role, source SHA, image digests, and redacted
   outcomes.

Emergency containment
---------------------

For suspected credential compromise, unexpected room creation, authorization
failure, or inability to prove media encryption:

1. Remove RTC focus discovery or set MESH_RTC_ENABLED=0 at the community service.
2. Revoke/rotate the LiveKit key pair through the operator secret store.
3. Stop public signalling/TURN ingress if ongoing abuse requires containment.
4. Preserve bounded content-free logs and timestamps; never capture media,
   message content, JWTs, access tokens, TURN credentials, or API secrets.
5. Keep Mesh voice unavailable until the root cause, physical/network matrix,
   and revocation/key-rotation evidence pass again.

Capacity and migration boundary
-------------------------------

The checked Compose file is a single-node baseline with a bounded UDP port
range. It is not HA and is not evidence for a larger-call capacity claim.
Record tested participants, streams, CPU, memory, packet loss, and relay usage
without account IDs or room names. Multi-node or multi-SFU work requires a
separate reviewed design and interoperable MatrixRTC acceptance. Community
operators must be able to disable or replace this calling service without
moving user accounts or trapping community membership.
