# Phase 1 native security boundaries

Status: implemented local fail-closed boundaries; the production gates below
must remain unavailable until their named dependencies are resolved.

## Invitation identity and admission service

Mesh must never send a reusable Matrix client access token to a community
admission service. Native create and claim requests instead obtain a
short-lived Matrix OpenID token and send it in a bounded JSON request body.
Each proof is bound to:

- an opaque UUID proof ID;
- the exact admission-service origin (`audience`);
- the authenticated Matrix user;
- one purpose (`create` or `claim`); and
- one subject (the community room ID or invitation capability).

The admission store persists only an HMAC digest of the issuing server,
verified user, and OpenID credential and rejects replay. Client-chosen envelope
fields such as proof ID, purpose, subject, and audience are validated but are
deliberately excluded from the one-use identity: changing any of them cannot
make the same credential reusable. It rejects a claim whose verified user
differs from the requested claimant. Authorization headers are rejected on
every admission API route.
Admission API resolve/claim requests carry invitation capabilities only in
POST bodies, never API paths or queries, and HTTP request paths are not logged.

Copied browser invitations use `/invite#capability`. A URL fragment is not
included in the HTTP request target or referrer. The generic landing page reads
the fragment locally under a nonce-bound CSP, clears it from browser history,
and constructs the native `mesh://join` handoff. Legacy `/invite/capability`
paths are rejected.

Production OpenID verification is intentionally unavailable by default. The
Matrix server-server OpenID userinfo API standardizes `access_token` as a URL
query parameter. That conflicts with Mesh's rule that credentials never enter
URLs. A deployment must provide a reviewed, POST-capable verifier that checks
the token with its issuing account service and returns the authenticated user.
Until that verifier exists, invitation creation and claim fail closed with
`identity_verifier_unavailable`.

The admission runtime identity is a dedicated non-admin Matrix bot configured
with `MESH_ADMISSION_SERVICE_USER_ID` and
`MESH_ADMISSION_SERVICE_ACCESS_TOKEN`. Startup verifies that the token belongs
to the configured user. The bootstrap creates this account with `admin: false`.
Its Matrix authority is limited by the communities and rooms that explicitly
join it and grant invite/read-state permission. It must not be a Synapse server
administrator.

Synapse's registration-token admin API does not expose an admission-only token
scope. Mesh therefore does not give the admission bot a server-admin token.
Registration-token issuance is an injected provider boundary and production
fails closed with `registration_issuer_unavailable` until a reviewed
least-privilege issuer is designed. Operator setup must also define how the bot
is added, with the minimum invite permission, to every admitted community and
child room. The existing shell/container wiring must not restore the old
server-admin admission identity.

References:

- Matrix server-server OpenID API: https://spec.matrix.org/latest/server-server-api/#openid
- Synapse registration-token admin API: https://element-hq.github.io/synapse/latest/admin_api/registration_tokens.html

## Opaque pending invitations

The encrypted native store owns the raw invitation and returns only a random
handle plus bounded non-secret metadata. Registration and joining accept that
handle, bind it to the selected account profile, reject concurrent or replayed
use, and consume the record only after a successful join.

Windows release builds receive initial and second-instance `mesh://join`
arguments directly in Rust. Exactly one bounded join URL is accepted. A cold
start persists the encrypted invitation before renderer setup completes, so
the first metadata peek cannot race a spawned storage task. Warm-instance
delivery emits `mesh-pending-invitation-ready` with an empty payload; the
renderer may only re-read metadata. New records begin in a
transition-independent native store and are bound to the selected account only
when registration or joining starts. The deep-link runtime and its raw URL
command/event permissions are not initialized.

macOS and Linux native-only delivery remain release platform gates. Argument
intake is explicitly disabled on those targets until native cold- and
warm-start handlers feed the same Rust storage function without ever publishing
the URL through webview events.

## Invitation networking

Admission origins use HTTPS outside an explicitly enabled loopback development
mode. The native client rejects credentials, paths, queries, fragments, private
and special-use literal IPs, resolves DNS under a deadline, rejects the origin
if any answer is unsafe, pins the verified address set, disables redirects, and
applies DNS, connect, read, total-request, address-count, and response-size
limits. IPv6 is conservatively limited to allocated global unicast space while
excluding IANA protocol-assignment, documentation, 6to4, and other special-use
prefixes inside that space; IPv4-mapped and deprecated compatible forms are
also rejected. Merely previewing pending metadata does not contact the network;
contact starts only after explicit join/account confirmation.

## Attachments and resource exhaustion

A central classifier combines filename extension, declared content type, magic
bytes, and bounded text sniffing. Active content is rejected on send. Received
active or ambiguous content may be saved to the private cache, but native open
is denied unless reclassification is unambiguously safe.

Native transfers register cancellation before scheduler waits. Uploads,
downloads, and full-image reads share the 200 MiB in-flight byte budget; network
downloads and full-image reads also share the download concurrency limit.
Unknown download sizes reserve the maximum attachment size. Invalid or
oversized reservation requests fail instead of being silently clamped. RAII
permits recover on cancellation and every error path. Pending-invitation
ciphertext reads are bounded before allocation and decrypted/serialized
plaintext buffers are zeroized. Message sends, DMs, edits, and attachment
captions enforce a 16 KiB UTF-8 limit in Rust.

## Moderation audit

Ordinary room messages are not authoritative audit records. A member can forge
one, a formerly authorized member can replay one after demotion, and messages
can be copied across communities, edited, or redacted. Mesh no longer writes or
parses prefixed room notices as audit evidence. Moderation actions report their
immediate per-room outcomes with `audit_recorded: false`; audit retrieval fails
closed.

Enabling audit history requires an append-only store with authenticated event
provenance, community binding, historical authorization at event time,
replay/idempotency rules, retention/export policy, and a federation threat
model. A renderer-only or room-message representation is not sufficient.
