# Mesh Agent 2 Wave 2 Handoff

Date: 2026-07-31
Repository: `D:\Creations\Applications\mesh`
Application: `D:\Creations\Applications\mesh\mesh`
Observed source HEAD: `72f093c84621183073ec43e233cfe0a26a1ca5f2`
Worktree state during all recorded runs: dirty

## Verdict

`LOCAL_RTC_READY_BUT_GATED`

The local MatrixRTC/LiveKit client, Matrix control-plane boundary, release
workflow controls, and evidence-validation machinery are implemented and
locally tested. Voice remains intentionally unavailable because no trusted
LiveKit/TURN deployment or physical/network acceptance evidence exists.
`media_e2ee_verified` remains false, the Rust join guard remains fail-closed,
and Matrix voice capability remains disabled.

This is not `LIVE_RTC_ACCEPTED` and not
`RELEASE_CANDIDATE_EVIDENCE_COMPLETE`. No signed or public release was
created.

## Files in this tranche

Tracked files changed:

- `.github/workflows/release-beta.yml`
- `mesh/scripts/beta-release-preflight.ps1`
- `mesh/scripts/matrixrtc-preflight.ps1`
- `mesh/src-tauri/src/backend/matrix.rs`
- `mesh/src-tauri/tests/matrix_federation_live_tests.rs`

New, currently untracked files:

- `mesh/infra/matrixrtc/MatrixRtcEvidence.psm1`
- `mesh/infra/matrixrtc/RUNBOOK.rst`
- `mesh/infra/matrixrtc/acceptance-matrix.example.json`
- `mesh/infra/matrixrtc/test-evidence-validation.ps1`
- `mesh/scripts/check-matrix-release-dependencies.ps1`
- `mesh/scripts/scan-release-artifacts.ps1`

No file was staged, committed, pushed, published, deployed, reset, stashed, or
discarded. Existing Agent 1 and Agent 3 worktree changes were preserved.

## Root causes fixed

### Bounded federation harness

The old membership/presence wait nested a normal approximately 30-second
Matrix long poll inside a 90-attempt loop. Its theoretical worst case was
roughly 45 minutes, and a caller timeout could cancel `sync_once` before it
restarted the normal background sync task.

The replacement uses:

- 20-second total deadline per presence transition;
- two-second client-side sync-attempt deadline;
- one-second server-side explicit sync poll;
- one-second observation budget;
- 1.5-second normal poll delay;
- 12-attempt maximum;
- three-second maximum 429 backoff;
- server `retry_after_ms` when available, capped by the total deadline;
- phase, attempt, elapsed time, last sanitized state, and sanitized error
  checkpoints;
- a 14-minute outer federation/recovery deadline;
- a two-minute outer fresh-registration deadline;
- start/end UTC, exact source SHA, worktree clean/dirty state, elapsed time,
  and exact result for every live test.

The 12-attempt cap initially combined with a 250 ms poll and accidentally
reduced the live deadline to about three seconds. The live policy now covers
roughly 18 seconds while the wall-clock limit remains authoritative.

### Presence publication

After an offline or invisible transition, Matrix SDK 0.18 represents
`PresenceState::Online` as the default sync value and serializes the request
without an explicit `set_presence=online` query value. The local Synapse
fixture retained the prior offline state. A direct protocol probe proved:

- explicit `set_presence=offline` produced remote offline;
- an omitted/default value left the user offline;
- explicit `set_presence=online` immediately produced local and federated
  online state.

`MatrixBackend::apply_wire_privacy` now publishes the selected state through
the standard authenticated Matrix presence endpoint. It keeps the background
sync on the same state and rolls back to the last successfully published
state if the explicit write fails. `user_preferences` and
`update_user_preferences` now propagate publication failures instead of
claiming success.

The live test begins with an explicit post-membership invisible/offline
transition because Synapse does not reliably replay presence established
before two remote users share the federated community.

### Tamper-evident RTC evidence

The old evidence document allowed arbitrary prose references and did not bind
artifacts, client build, source SHA, or a clean worktree.

Schema version 2 and its validator now require:

- exact `sourceSha == HEAD`;
- clean tracked and untracked source;
- evidence outside the source worktree or under an explicitly Git-ignored
  in-tree directory;
- non-placeholder operator, client build, devices, networks, homeservers, and
  service endpoints;
- tested client provenance bound to the same source SHA;
- stable unique evidence IDs;
- artifact kind, relative path, SHA-256, byte size, media type, capture time,
  and sanitized description;
- canonical paths below the explicit evidence root;
- no path traversal, symbolic link, junction, duplicate path, missing file,
  size mismatch, or digest mismatch;
- case references by evidence ID only;
- every artifact referenced by a result or the client build;
- passed cases backed by service and client diagnostics;
- all 23 cases exactly once;
- `not-applicable` only for the one schema-approved cross-client case and only
  with a real reason;
- timestamps no more than 30 days old and no more than five minutes in the
  future;
- content scanning for tokens, credentials, secrets, and direct Matrix
  identifiers;
- pinned LiveKit and authorization-service image digests;
- sanitized/no-secret attestation.

The runbook documents evidence-root isolation, hashing, canonical-path rules,
redaction, secret categories, and the rule that evidence is content-free.

Offline preflight ends with:

`MatrixRTC configuration validated; no live evidence collected. This does not authorize production deployment.`

### Deterministic release and legacy isolation

The beta workflow now has:

- explicit release-version input for manual dispatch;
- exact tag/application-version validation;
- hard rejection of placeholder `0.1.0` on release paths;
- exact clean source SHA and tracked/untracked cleanliness checks;
- Matrix-only build/check/SBOM feature flags;
- raw Rust advisory reporting separate from the scoped gate;
- mechanical Matrix-versus-legacy dependency proof;
- evidence-validator tests and offline MatrixRTC/operator preflights;
- pinned CycloneDX generator;
- Node and Rust CycloneDX SBOMs;
- build provenance bound to `GITHUB_SHA` and release version;
- SHA-256 checksums covering installers, both SBOMs, and provenance;
- GitHub build-provenance attestation inputs;
- configured-secret and secret-pattern artifact scan;
- signed MSI and NSIS verification before draft release creation;
- draft and prerelease behavior;
- updater output disabled.

Two obsolete audit ignores were removed after proving `quick-xml 0.41.0`
satisfies the patched versions for `RUSTSEC-2026-0194` and
`RUSTSEC-2026-0195`. The five current legacy vulnerabilities remain visible
and separately scoped.

## Two independent reset/live-test results

Both successful cycles occurred after the final explicit-presence fix. Earlier
failed diagnostic runs do not count.

### Cycle 1

- Reset command: `npm run setup:matrix-spike:reset`
- Test command:
  `CARGO_BUILD_JOBS=1; npm run test:matrix-spike`
- Full Cargo suite: 186.91 seconds
- Federation/recovery start:
  `2026-07-31T05:07:23.121038600+00:00`
- Federation/recovery end:
  `2026-07-31T05:10:22.755562300+00:00`
- Federation/recovery elapsed: 179,634 ms
- Fresh registration elapsed: 7,012 ms
- Result: two passed, zero failed

### Cycle 2

- Reset command: `npm run setup:matrix-spike:reset`
- Test command:
  `CARGO_BUILD_JOBS=1; npm run test:matrix-spike`
- Full Cargo suite: 186.54 seconds
- Federation/recovery start:
  `2026-07-31T05:11:03.514650700+00:00`
- Federation/recovery end:
  `2026-07-31T05:14:02.923349+00:00`
- Federation/recovery elapsed: 179,408 ms
- Fresh registration elapsed: 6,892 ms
- Result: two passed, zero failed

Each run passed encrypted federated DMs, stale `m.direct` reconciliation,
directory/knock/join, community/channel/roster projection, four explicit
presence transitions, room metadata and power levels, emoji/media/reactions,
encrypted messages and pins, legacy provenance, relations/receipts/typing,
redaction, forced Synapse restart, exactly-once offline delivery, catch-up,
fresh-device recovery/decryption, notification reconciliation, room upgrade
history, account-data propagation, same-device restore, ban, and moderation
audit.

The disposable Docker containers, proxies, network, and volumes were removed
after verification. No Cargo or Rust process remained. Windows account-store
cleanup logged deferred deletion for these two disposable test directories,
which still existed after all processes stopped:

- `C:\Users\dhawa\AppData\Local\Temp\.tmpfowK72`
- `C:\Users\dhawa\AppData\Local\Temp\.tmp1FFWCq`

Both were validated as OS-temp children with 12 files each. Recursive deletion
was rejected by the execution safety policy, so they were not bypassed or
force-removed through another shell.

## RTC evidence validator test results

`mesh/infra/matrixrtc/test-evidence-validation.ps1`:

- 15 passed;
- zero failed.

Covered cases:

1. complete manifest passes;
2. explicitly ignored in-tree evidence passes;
3. unignored in-tree evidence is rejected;
4. dirty source is rejected;
5. wrong source SHA is rejected;
6. missing artifact is rejected;
7. changed hash is rejected;
8. path traversal is rejected;
9. symbolic-link/junction escape is rejected;
10. duplicate artifact ID is rejected;
11. unknown evidence reference is rejected;
12. stale timestamp is rejected;
13. future timestamp is rejected;
14. incomplete case is rejected;
15. placeholder content is rejected.

## RTC implementation and gate state

The existing local renderer path includes:

- pinned `livekit-client`;
- connect/disconnect and reconnect state;
- participant removal and authoritative media snapshots;
- microphone mute, deafen, camera, and screen-share controls;
- input and output device switching;
- permission/device error handling;
- publication lease checks;
- membership-bound media-key application and rotation hooks;
- LiveKit encryption worker and active-E2EE checks;
- fail-closed participant encryption handling;
- bounded, content-free connection diagnostics.

Local verification:

- focused voice Vitest: three files, 42 tests passed;
- Rust voice boundary test: one passed;
- complete Matrix Rust suite: 165 unit tests passed, IPC contract test passed,
  harness unit tests passed;
- Clippy Matrix/all-targets with `-D warnings`: passed.

The following hard gates remain unchanged:

- `VoiceServiceAvailability::ClientUnavailable`;
- Matrix `BackendCapabilities.voice == false`;
- `require_matrix_rtc_media_e2ee_ready()` returns `Unsupported`;
- Rust enforces that guard before membership publication or token request;
- `MatrixRtcJoinResult.media_e2ee_verified` remains false;
- `VoiceServiceStatus.media_e2ee_verified` remains false.

This is intentional. The renderer's active encryption checks are not a
substitute for trusted SFU/TURN, key-rotation, revocation, and physical-device
evidence. `media_e2ee_verified` must not change until a real supported active
call proves encryption and rotation.

## Physical/network acceptance matrix

The tracked template makes no live claim. All 23 results remain `not-run`.

| Case | Result | Missing evidence |
| --- | --- | --- |
| `two-windows-same-lan` | not-run | Two physical Windows devices and trusted live services |
| `two-windows-different-networks` | not-run | Two independent networks and trusted live services |
| `windows-plus-supported-client` | not-run | Reviewed second supported client |
| `restrictive-nat` | not-run | Authorized restrictive/symmetric NAT environment |
| `udp-blocked-turn-tcp-tls` | not-run | Deployed TURN/TCP or TURN/TLS and UDP-blocked network |
| `network-loss-reconnect` | not-run | Live call with controlled network interruption |
| `active-kick` | not-run | Trusted SFU plus live moderation/revocation |
| `active-ban` | not-run | Trusted SFU plus live moderation/revocation |
| `logout-during-call` | not-run | Live session/token revocation |
| `device-removal-during-call` | not-run | Live device removal and media-key revocation |
| `permission-loss-during-call` | not-run | Live permission mutation and media revocation |
| `room-departure-during-call` | not-run | Live departure and delayed-leave cleanup |
| `screen-share-start-stop` | not-run | Physical capture and remote playback |
| `screen-share-permission-denied` | not-run | OS permission-denial environment |
| `app-restart-during-call` | not-run | Signed physical build and live service |
| `app-restart-after-call` | not-run | Signed physical build and ghost cleanup observation |
| `media-key-rotation-late-join` | not-run | Multi-device active media-E2EE rotation |
| `three-person-call` | not-run | Three physical participants |
| `larger-invited-call` | not-run | Larger invited physical group |
| `cross-service-call` | not-run | Federated account/community services plus RTC auth |
| `input-output-device-switch` | not-run | Multiple physical input/output devices |
| `push-to-talk-deafen-mute` | not-run | Physical audio observation |
| `concurrent-camera-screen-share` | not-run | Physical camera/share capture and remote playback |

## Raw versus Matrix-release dependency evidence

Raw `cargo audit`:

- exit code 1;
- five vulnerabilities;
- 27 allowed warnings.

Vulnerabilities and legacy traces:

- `RUSTSEC-2026-0119`, `hickory-proto 0.24.4`:
  `libp2p-mdns -> libp2p -> mesh`;
- `RUSTSEC-2025-0009`, `ring 0.16.20`:
  `rcgen -> libp2p-tls -> libp2p-quic -> libp2p -> mesh`;
- `RUSTSEC-2026-0098`, `RUSTSEC-2026-0099`, and
  `RUSTSEC-2026-0104`, `rustls-webpki 0.101.7`:
  `libp2p-tls -> libp2p-quic -> libp2p -> mesh`.

Matrix release dependency proof:

- `libp2p`: absent;
- `hickory-proto 0.24.4`: absent;
- `ring 0.16.20`: absent;
- `rustls-webpki 0.101.7`: absent.

Legacy compilation remains separate and retains all four package findings.
They are not reported as fixed.

The release-scoped audit ignores only the five listed legacy vulnerabilities,
exits zero, and still reports the 27 warning-class findings. Raw and scoped
results remain separate in CI.

The locally executed pinned CycloneDX command produced a valid CycloneDX 1.3
Rust SBOM with 557 components and no `libp2p`. The transient local SBOM was
removed after validation; the release workflow regenerates it.

## Local workflow evidence

Passed:

- `cargo fmt --all -- --check`;
- Matrix Clippy/all-targets with `-D warnings`;
- `npm run test:rust:matrix`;
- two independent reset/live federation cycles;
- focused voice Vitest, 42 tests;
- Rust voice boundary test;
- `npm run matrixrtc:preflight`;
- `npm run operator:smoke` in static/offline mode;
- `npm run release:preflight`;
- explicit `0.1.0` release-version rejection;
- dirty tracked/untracked clean-source rejection;
- Matrix/legacy dependency boundary script;
- raw-versus-scoped audit execution;
- exact legacy advisory `cargo tree` traces;
- PowerShell parser checks;
- acceptance JSON parsing;
- release workflow YAML parsing;
- release artifact scanner against representative files;
- pinned `cargo-cyclonedx 0.5.9` install and exact workflow command;
- generated SBOM validation.

These runs used a dirty worktree and are local engineering evidence, not
release provenance.

## Evidence not collected

### Signed artifact evidence

Not collected:

- publisher identity;
- signing certificate/private key;
- signed same-SHA MSI and NSIS;
- Authenticode/timestamp verification on produced installers;
- clean-machine publisher verification.

### Public release evidence

Not collected:

- GitHub release publication;
- public asset downloads;
- canonical release URL;
- latest-download redirects;
- public SBOM/provenance/checksum agreement.

The workflow creates a draft prerelease only after signed artifact checks.
Nothing was published in this tranche.

### Update evidence

The updater remains disabled: no updater plugin/capability, public key,
endpoint, signed manifest, or release channel is configured. No claim exists
for update, tampered-manifest rejection, partial-download recovery, rollback,
or channel behavior.

### Operator/infrastructure evidence

Static operator configuration passed, but no live evidence was collected for:

- DNS/TLS and renewal failure;
- Mac mini or another independent public/community service;
- production federation;
- LiveKit authorization service, SFU, or TURN;
- database/media/signing-key/configuration/secret backup and restore;
- restore timing or integrity;
- router/firewall recovery;
- quotas, rate limits, log rotation, disk alarms, clock sync, or monitoring;
- degraded federation, TURN failure, full disk, compromise, containment, or
  rollback;
- public legal/privacy/security/support/abuse pages.

The Mac mini remains optional community-hosted/BYOH infrastructure with no
Mesh uptime SLA. No paid Mesh-operated service is required or implied.

## Exact Agent 1 shared-file integration requests

1. In `mesh/src-tauri/src/backend/matrix.rs`, preserve both sets of current
   shared edits:
   - Agent 3's `RoomPowerLevelsContentOverride` import and community/channel
     role-power-level assignments;
   - Agent 2's `SetPresenceRequest` import, fallible explicit presence
     publication with rollback, and one-second explicit `sync_once` poll.
2. Preserve the bounded helpers and outer run records in
   `mesh/src-tauri/tests/matrix_federation_live_tests.rs`; do not restore the
   old 90-attempt long-poll loop or the pre-membership online assertion.
3. Preserve the explicit version/clean-SHA/Matrix-only/SBOM/provenance/audit
   split in `.github/workflows/release-beta.yml`. Do not publish it while the
   app remains `0.1.0` or signing/live gates are absent.
4. After all agents stop, reconcile `PRODUCTION_BETA_PLAN.md` from this
   handoff. Record the two local federation passes and validator results, but
   keep MatrixRTC, release, updater, public download, and operator production
   gates incomplete.
5. Keep all 23 physical/network cases `not-run` unless artifact-backed
   evidence passes `-RequireLiveAcceptance`.

## Remaining blockers and stop conditions

External authority or resources are required for:

- LiveKit authorization/SFU/TURN deployment and mutation;
- two physical Windows devices, a reviewed second client, and controlled
  network/NAT conditions;
- production accounts, secret rotation, and federated operator services;
- DNS, TLS, router, firewall, Mac mini, backup, restore, monitoring, and
  incident exercises;
- publisher identity, signing certificate, updater signing material, release
  credentials, GitHub publication, and canonical public-download validation;
- public legal/privacy/security/support/abuse review.

Do not weaken rate limits, media encryption, key rotation, revocation,
artifact provenance, audit gates, or the Rust voice guard to bypass these
blockers.
