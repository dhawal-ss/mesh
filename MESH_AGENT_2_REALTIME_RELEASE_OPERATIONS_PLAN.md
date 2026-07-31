# Mesh Agent 2 - remaining RTC, release, live verification, and operations

## Mission

This is the second-wave brief. Convert the existing MatrixRTC templates,
release workflow, and operator checks into trustworthy implementation and
evidence. Own the Matrix backend during parallel work, make the live federation
suite deterministic, isolate production Matrix releases from legacy dependency
risk, and keep voice/release capabilities disabled until real acceptance passes.

Read before changing anything:

- `AGENTS.md`
- `MESH_COMPETITIVE_PRODUCTION_PLAN_2026-07-30.md`
- `PRODUCTION_BETA_PLAN.md`
- `mesh/infra/matrixrtc/RUNBOOK.rst`
- `mesh/infra/matrixrtc/acceptance-matrix.example.json`
- the complete current `git status` and diffs for every file you intend to edit

## Verified starting point and known failures

The first wave added:

- a MatrixRTC runbook and 23-case physical/network acceptance template;
- offline MatrixRTC configuration validation;
- release-workflow invocation of MatrixRTC and operator preflights;
- static operator checks and existing fail-closed voice readiness.

The post-wave audit found:

1. Voice is still intentionally unavailable.
   `VoiceServiceStatus::matrix_rtc` returns `ClientUnavailable`, and the
   Matrix join result still reports `media_e2ee_verified: false`.
2. All 23 MatrixRTC acceptance cases are still `not-run`; no live media,
   TURN/TCP/TLS, key-rotation, revocation, or physical-device evidence exists.
3. `matrixrtc-preflight.ps1` binds evidence to `git rev-parse HEAD` but does not
   reject a dirty worktree. It accepts hand-written evidence reference strings
   without hashing or verifying the referenced artifacts.
4. One clean two-homeserver reset/run passed. A second reset succeeded, but the
   test did not finish within 15 minutes. `wait_for_member_presence` can spend
   roughly 45 minutes because it invokes a normal long-poll sync in a 90-try
   loop. Logs also showed remote-join `429 Too Many Requests`.
5. Local release preflight passes, but the app is version `0.1.0`, updater
   support is disabled, and no signed MSI/NSIS, SBOM/provenance, checksum,
   clean-machine, rollback, or public-download evidence exists.
6. Raw `cargo audit` reports five advisories in the legacy libp2p dependency
   tree (`hickory-proto 0.24.4`, `ring 0.16.20`, and three advisories for
   `rustls-webpki 0.101.7`). The Matrix feature tree does not contain those
   vulnerable versions. The release ignore list currently turns them into 27
   allowed warnings.
7. Mac mini federation, backup/restore, quotas, monitoring, incident, DNS/TLS,
   and router recovery remain external/operator acceptance work.

Treat this as a snapshot. Reverify current code before editing.

## Parallel ownership contract

All three agents may be using the same dirty `main` checkout.

- Do not create a branch, stage, commit, push, deploy, release, reset, stash,
  clean, or discard changes.
- Preserve all tracked and untracked work.
- Before every edit, run `git diff -- <path>` and reread the file.
- Do not run a repository-wide formatter.
- Rust commands must be serialized with `--jobs 1` or
  `CARGO_BUILD_JOBS=1`.
- Coordinate resource-heavy compiles and Docker resets. During parallel work,
  run focused tests only; the live harness may run after the other agents have
  stopped compiling.
- A command in this brief is not authorization to mutate DNS, firewalls,
  routers, production services, real accounts, GitHub releases, Pages, or
  signing infrastructure.

### Files owned by this lane

- `mesh/src-tauri/src/backend/matrix.rs`
- `mesh/src-tauri/src/backend/mod.rs`
- RTC-specific Rust modules and tests under
  `mesh/src-tauri/src/backend/matrix/`
- `mesh/src-tauri/tests/matrix_federation_live_tests.rs`
- `mesh/src-tauri/src/app_runtime/voice_handler.rs`
- `mesh/src-tauri/src/commands/voice.rs`
- `mesh/src-tauri/src/state/voice_state.rs`
- `mesh/src/components/voice/**`
- `mesh/src/lib/livekit-voice.ts`
- `mesh/src/lib/livekit-voice.test.ts`
- `mesh/src/lib/voice-*.ts`
- `mesh/src/lib/voice-*.test.ts`
- `mesh/src/store/voice.ts`
- `mesh/src/store/voice.test.ts`
- `mesh/infra/matrixrtc/**`
- `mesh/infra/matrix-spike/**`
- `mesh/infra/homeserver/**`
- `mesh/infra/operator-smoke/**`
- `mesh/scripts/matrixrtc-preflight.ps1`
- `mesh/scripts/operator-smoke.ps1`
- `mesh/scripts/beta-release-preflight.ps1`
- `.github/workflows/release-beta.yml`
- release/operator site files
- `mesh/src-tauri/tauri.conf.json`
- `mesh/src-tauri/Cargo.toml`
- `mesh/src-tauri/Cargo.lock`

Agent 1 owns OIDC/onboarding/account files. Agent 3 owns community/chat,
permission, forum, expression, and moderation files. Do not edit those paths.

Shared IPC registration files remain read-only. Implement leaf APIs and record
an exact integration request for Agent 1:

- `mesh/src/App.tsx`
- `mesh/src/lib/bridge.ts`
- `mesh/src/types/ipc.generated.ts`
- `mesh/src-tauri/src/lib.rs`
- non-voice files under `mesh/src-tauri/src/commands/`
- `mesh/package.json`
- `mesh/package-lock.json`
- `PRODUCTION_BETA_PLAN.md`

## B0 - make the live federation suite bounded and repeatable

Fix the nondeterministic test harness before collecting more evidence.

Requirements:

1. Replace `wait_for_member_presence` with an explicit wall-clock deadline.
   Do not call an unbounded/default 30-second sync on every retry.
2. Bound each sync attempt, preserve useful errors, and report the last observed
   membership/presence state at timeout.
3. Print sanitized progress checkpoints so a stalled run identifies the
   current phase without exposing credentials or message content.
4. Handle Matrix `M_LIMIT_EXCEEDED`/429 using the server-provided
   `retry_after_ms` when available, with bounded backoff and a total deadline.
   Do not disable production rate limits to make the test pass.
5. Ensure a timed-out run releases SDK stores, processes, and containers it
   started. No orphaned Cargo/test processes may remain.
6. Keep reset operations confined to the disposable
   `mesh/infra/matrix-spike` state. Never reset a real service.

Acceptance:

- one membership wait has a small documented maximum, not a 45-minute worst
  case;
- a forced no-progress case fails within that bound with the phase and last
  state;
- 429 retry behavior is tested;
- after compilation is warm, two independent `reset -> live test` cycles pass
  within a declared outer deadline;
- each run records start/end time, source SHA, clean/dirty state, and exact test
  result.

If a second run still fails, diagnose the actual endpoint/log phase. Do not
report the first pass twice.

## B1 - make live MatrixRTC evidence tamper-evident

Harden the schema and preflight.

Required behavior for `-RequireLiveAcceptance`:

1. Require a clean tracked and untracked worktree for the tested source. Store
   generated evidence outside the tracked source tree or in an explicitly
   ignored evidence directory.
2. Require `sourceSha` to equal `HEAD`, and require the tested client
   artifact/provenance to bind to that same SHA.
3. Add an evidence-artifact manifest. Every referenced service log, client log,
   packet/network result, screenshot, or operator record must have:
   - a stable evidence ID;
   - a path below an explicit evidence root;
   - SHA-256;
   - byte size and media type;
   - capture timestamp and sanitized description.
4. Test cases must reference evidence IDs, not arbitrary prose strings.
5. Resolve paths canonically, reject path traversal/symlink escape, verify file
   existence, hash, size, uniqueness, and that every reference is used.
6. Reject placeholder operators, devices, networks, services, timestamps,
   client builds, homeservers, SFU/TURN endpoints, and result notes.
7. Preserve `not-applicable` only for cases explicitly allowed by the schema
   and require a reason.
8. Document redaction. Evidence must not contain tokens, TURN credentials,
   secrets, message text, media payloads, or personal contact data.

Add positive and negative tests for dirty source, wrong SHA, missing artifact,
changed hash, path escape, duplicate ID, unknown reference, stale/future
timestamp, incomplete case, and placeholder content.

Offline preflight must continue to say "configuration validated; no live
evidence collected."

## B2 - complete the RTC client only behind truthful readiness

Implement the missing local client path using the existing pinned
`livekit-client` dependency and MatrixRTC membership/token boundary. Do not add
a legacy peer-to-peer fallback.

Required local behavior:

- MatrixRTC focus discovery and reachability;
- federated focus selection compatible with the deployed authorization service;
- short-lived room/identity/permission-scoped LiveKit token use;
- LiveKit connect/disconnect/reconnect with ghost-participant cleanup;
- MatrixRTC membership join, delayed leave where supported, and cleanup;
- mute, deafen, input/output device, camera, and screen-share state;
- permission-denied and device-loss recovery;
- explicit TURN/UDP-blocked and SFU-unavailable states;
- membership-bound media-key distribution and rotation;
- prompt participant/media revocation after kick, ban, logout, device removal,
  permission loss, or room departure;
- content-free, bounded diagnostics and metrics.

`media_e2ee_verified` must be derived from actual supported, active media
encryption and rotation state. Never set it to `true` as a configuration
shortcut. `ClientUnavailable` may change only after the client path works and
the readiness inputs are trustworthy.

Keep the feature hidden or unavailable if focus, TURN, encryption, rotation,
or revocation evidence is incomplete.

### Required physical/network matrix

Complete the 23-case acceptance document with real evidence covering:

- two Windows devices;
- Windows plus another supported client when available;
- same LAN and different networks;
- restrictive/symmetric NAT;
- UDP blocked with TURN/TCP or TURN/TLS;
- temporary network loss and reconnect;
- kick/ban/permission loss during a call;
- device revocation and key rotation;
- voice, camera, screen-share start/stop and permission denial;
- restart during and after a call;
- multi-party join/leave without ghosts;
- removed-device inability to continue decrypting media.

If the required devices, networks, or services are not available, finish local
implementation/tests, leave voice gated, and report the precise live case as
blocked.

## B3 - make the Matrix release path secure and reproducible

Complete all deterministic release engineering that does not require a real
publisher identity.

Deliver:

- an explicit release version input and validation; do not silently publish
  placeholder `0.1.0`;
- Matrix-only production build flags with no legacy libp2p fallback;
- updater integration that is disabled unless a valid public key, endpoint,
  signed manifest, and release channel are configured;
- signature rejection, partial-download recovery, rollback, and channel tests;
- CycloneDX or SPDX SBOM, SHA-256 checksums, and build provenance tied to the
  exact clean source SHA;
- artifact secret scans and sanitized workflow logs;
- canonical release/latest-download validation;
- draft/prerelease behavior until every hard gate passes.

Signing and public publication remain external:

- signed MSI and NSIS from the same clean source SHA;
- publisher verification on a clean Windows device;
- public release metadata, SBOM, provenance, checksums, and artifacts agreeing;
- installed launch, invitation resume, update, rollback, uninstall, reinstall;
- tampered updater manifest and binary rejection.

Never publish or label a `NotSigned` installer as a release candidate.

## B4 - remove or isolate legacy dependency risk

The production Matrix artifact must not inherit legacy transport risk.

1. Reproduce raw audit results and trace every advisory with `cargo tree`.
2. Confirm the Matrix feature graph contains none of the five vulnerable legacy
   versions.
3. Prefer compatible legacy dependency upgrades when they preserve the
   separately compiled LAN/off-grid artifact.
4. If safe upgrades are not available, make the isolation explicit in build,
   CI, packaging, and documentation. Do not allow the release ignore list to
   imply the advisories are fixed.
5. Remove an audit ignore only when the dependency is upgraded/removed or the
   production graph is mechanically proven not to include it.
6. Keep legacy tests and compile checks; do not delete user functionality merely
   to make `cargo audit` green without a product decision.

Acceptance:

- Matrix release dependency tree contains no `libp2p` and no listed vulnerable
  version;
- legacy advisory status is explicit, owner-visible, and cannot silently enter
  the Matrix release;
- CI proves the feature boundary;
- raw and release-scoped audit results are reported separately.

## B5 - operator and external production acceptance

When authorized infrastructure is available, collect real evidence for:

- two independent homeservers and cross-service community join;
- fresh-store decryption of historical rooms/DMs, edits, and replies;
- backup/restore of database, media, signing keys, configuration, and secrets;
- restore timing and integrity checks;
- DNS/TLS renewal and failure warning;
- router/firewall recovery;
- quotas, rate limits, log rotation, disk alarms, clock sync, and monitoring;
- degraded federation, TURN failure, full disk, database restore, credential
  compromise, incident containment, and rollback;
- abuse reports, bans, invites, join rules, and emergency containment;
- legal/privacy/security/support/abuse pages available from public release
  surfaces.

The Mac mini remains optional community-hosted/BYOH infrastructure with no Mesh
uptime SLA. Production must not require a paid Mesh-operated service.

## Verification

Focused local checks:

```powershell
cd mesh
npx vitest run src/components/voice src/lib/livekit-voice.test.ts src/store/voice.test.ts --maxWorkers=1

$env:CARGO_BUILD_JOBS='1'
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --features matrix-backend --locked --jobs 1 voice
npm run matrixrtc:preflight
npm run operator:smoke
npm run release:preflight
```

After the harness fix and when no other agent is compiling:

```powershell
cd mesh
npm run setup:matrix-spike:reset
npm run test:matrix-spike
npm run setup:matrix-spike:reset
npm run test:matrix-spike
```

Release/security checks:

```powershell
cd mesh
$env:CARGO_BUILD_JOBS='1'
cargo clippy --manifest-path src-tauri/Cargo.toml --no-default-features --features matrix-backend --all-targets --locked --jobs 1 -- -D warnings
npm run test:rust:matrix

cd src-tauri
cargo tree --no-default-features --features matrix-backend --locked
cargo tree --no-default-features --features legacy-p2p --locked
cargo audit
```

Use the repository's documented release-scoped audit command as a separate
result. Do not hide raw audit failures.

## Stop conditions

Stop and report, rather than guess, when work requires:

- live DNS, TLS, router, firewall, Mac mini, homeserver, LiveKit, or TURN
  mutation;
- production accounts, secret rotation, or data reset;
- a signing certificate, legal publisher identity, release/store credential,
  or updater private key;
- publishing GitHub releases, Pages, or canonical downloads;
- paid service enrollment;
- weakening rate limits, media encryption, key rotation, revocation, artifact
  provenance, or audit gates;
- editing Agent 1 or Agent 3 paths.

## Required handoff

Create `MESH_AGENT_2_WAVE2_HANDOFF.md` containing:

- files changed and root causes fixed;
- deterministic live-harness deadlines and two independent run results;
- preflight schema and negative-test results;
- RTC implementation status and every physical/network case result;
- exact `media_e2ee_verified` and capability-gating rationale;
- raw versus Matrix-release dependency/audit results;
- signed/public/update/operator evidence separated from local workflow evidence;
- exact shared-file integration requests for Agent 1;
- unresolved external blockers;
- an explicit verdict: `LOCAL_RTC_READY_BUT_GATED`, `LIVE_RTC_ACCEPTED`,
  `RELEASE_CANDIDATE_EVIDENCE_COMPLETE`, or `BLOCKED`, with reasons.

Do not edit `PRODUCTION_BETA_PLAN.md`; Agent 1 will reconcile it from this
handoff after all agents stop.
