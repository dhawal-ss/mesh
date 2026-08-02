# Mesh Agent 2 — Voice, Network Acceptance, Operations, and Performance

**Date:** 2026-07-31
**Run on:** `main` only
**Starting documentation SHA:** `b2427b6`
**Integrated implementation SHA:** `7effb0c`
**Master plan:** `MESH_SOL_PRODUCTION_IMPLEMENTATION_PLAN_2026-07-31.md`

## Mission

Close the implementable parts of WP-03 through WP-07, WP-20, and WP-25. Make MatrixRTC/LiveKit the one honest production voice path, harden the separate legacy LAN artifact, and collect evidence without enabling capabilities prematurely.

The master audit’s original “no TURN infrastructure exists” statement was stale. `mesh/infra/matrixrtc/docker-compose.yml` already configures LiveKit-integrated UDP/TLS TURN. The missing work is deployment and live acceptance, not a new legacy TURN architecture.

WP-00 and WP-01 are complete. Voice remains deliberately unavailable in Matrix release builds, `media_e2ee_verified` remains false without proof, and the 23 physical/network cases remain not-run.

## Read first

1. `AGENTS.md`
2. `PRODUCTION_BETA_PLAN.md`, especially Z7, current external gates, and stop conditions
3. `MESH_SOL_PRODUCTION_IMPLEMENTATION_PLAN_2026-07-31.md`
4. `mesh/infra/matrixrtc/RUNBOOK.rst`
5. `mesh/infra/matrixrtc/acceptance-matrix.example.json`
6. This file and current repository status/log

## Parallel-work contract

- Use the existing `main` worktree. Never create/switch branches, reset, clean, stash, or overwrite another agent’s edits.
- Do not stage, commit, push, deploy, expose ports, change DNS/router state, or publish unless explicitly authorized by the user.
- Preserve all unrelated dirty paths.
- Agent 2 exclusively owns during the parallel phase:
  - `mesh/src-tauri/src/backend/matrix.rs`
  - `mesh/src-tauri/src/backend/matrix/rtc.rs`
  - MatrixRTC-focused portions of `mesh/src-tauri/src/backend/mod.rs`
  - `mesh/src/lib/livekit-voice.ts`, `voice-engine.ts`, `voice-peer.ts`, `voice-runtime.ts`, `voice-policy.ts`
  - `mesh/src/components/voice/**`, `mesh/src/store/voice.ts`
  - `mesh/src/hooks/useVoiceEngine.ts`
  - `mesh/infra/matrixrtc/**`, `mesh/src-tauri/tests/turn_probe_live_tests.rs`
  - MatrixRTC/operator/release/soak workflows and scripts
- Do not edit Agent 1’s recovery/privacy/notification/invite settings UI or `.github/workflows/security.yml`.
- Do not edit Agent 3’s design tokens, command palette, general community/onboarding UI, accessibility E2E, or `vite.config.ts`.
- Shared IPC/bridge/app/package files stay read-only. Record required integration in this file; Agent 1 wires them after the parallel phase.
- Append results to this file. Do not create a handoff Markdown file.

## Required implementation order

### A2-0 — Establish the fail-closed baseline

Before editing, prove and record:

- Matrix `BackendCapabilities.voice === false`;
- `VoiceServiceStatus.media_e2ee_verified === false`;
- no release environment silently turns either on;
- `legacy-p2p` is a separately built LAN artifact and its dependencies are absent from the Matrix release tree;
- text chat, DMs, invitations, and offline sync remain usable while voice is unavailable.

Add or preserve behavior tests for every assertion. Never flip capability flags from unit-test evidence.

### A2-1 — WP-03: production MatrixRTC/LiveKit/TURN source readiness

Audit and harden the existing stack rather than adding a second TURN service.

Acceptance criteria:

1. LiveKit authorization is tied to authenticated Matrix identity, room membership, current membership epoch, current room permission, and the expected SFU URL.
2. TURN UDP and TURN-over-TLS operator paths have explicit DNS/TLS/firewall requirements, health checks, credential rotation, bounded logs, and no committed credentials.
3. `.well-known` discovery keeps account service and community hosting separate and fails closed on insecure/unexpected origins.
4. The client maps microphone/camera permission denial (`NotAllowedError` and platform equivalents) to a plain next action such as opening system settings.
5. Join, reconnect, app restart, membership lease expiry, key rotation, kick/ban, and service revocation cannot continue publishing media with stale authority.
6. Active media E2EE is required before audio/video publication. A configured SFU is not proof of E2EE.
7. The source preflight and evidence validator reject fabricated, stale, wrong-SHA, wrong-device, missing-TURN, or missing-E2EE evidence.
8. The zero-cost architecture remains honest: this can be an optional BYOH/community service, and public-service text use remains available without it.

Local work may complete code, tests, runbooks, and validation. Actual host deployment remains an owner action unless separately authorized.

### A2-2 — WP-04: repair the legacy LAN voice engine without promoting it

In `mesh/src/lib/voice-engine.ts`:

1. Recreate a closed `AudioContext`; continue to resume a suspended one.
2. Stop every track before removing a relay-received stream on peer disconnect and during full teardown.
3. Remove direct use of private `SimplePeer.negotiate()`. Prefer a documented public track/stream renegotiation path. If the dependency has no stable public seam, isolate the compatibility behavior behind `voice-peer.ts` with focused tests and a version-pinning comment.
4. Add regression tests that fail on the old behavior, including repeated disconnect and teardown.
5. Preserve the Matrix/legacy dependency boundary and do not wire this engine into Matrix release builds.

Do not configure production TURN credentials in renderer code. The legacy artifact may consume operator-provided ICE configuration through its existing secure native boundary.

### A2-3 — WP-05: physical/network MatrixRTC acceptance

The gate is the checked-in 23-case schema and validator. Do not replace it with prose or unit tests.

Required evidence:

- at least two physical or faithfully isolated devices;
- at least two independent networks, including restrictive NAT/firewall coverage;
- direct and TURN-relayed media;
- join/leave/rejoin, reconnect, app restart, sleep/wake, device changes;
- late join during key rotation;
- kick, ban, permission downgrade, logout, and service revocation mid-call;
- screen share/camera/microphone permission denial and recovery;
- active media E2EE and failure-closed behavior;
- exact release/source SHA and timestamped bounded logs with secrets redacted.

Only owner-approved live infrastructure can satisfy this. If credentials/devices are absent, leave every unrun case `not-run`, complete the source prerequisites, and report the external blocker. Never synthesize a passing evidence file.

`BackendCapabilities.voice` and `media_e2ee_verified` may change only after 23/23 valid live cases and an explicit user-approved release decision.

### A2-4 — WP-06: persistent voice rooms and sidebar occupancy

Start implementation only after the underlying MatrixRTC state model is trustworthy; keep the UI capability-gated until A2-3 passes.

Acceptance criteria:

- a voice room is a standing Matrix room/MatrixRTC slot, not a ringing call;
- one action joins; no accept/ring flow;
- live occupants and speaking/mute state update from current authenticated call membership, not stale local cache;
- every voice room has an attached text room or documented same-room text timeline available independently of call presence;
- occupancy disappears promptly on leave, membership expiry, revocation, and app termination;
- the list never leaks occupancy to a user who cannot join/inspect that room;
- unavailable voice shows a plain action/reason while text remains fully usable;
- keyboard, screen-reader, reduced-motion, and small-window behavior pass.

Agent 2 owns voice-specific UI. Use existing design tokens; do not redesign the global shell.

### A2-5 — WP-07: voice-independent text and offline sync

Add executable acceptance tests proving:

1. joining/leaving voice never gates room history, sending, search, reactions, replies, edits, pins, or attachments;
2. text sent while the peer is offline syncs on reconnect without joining voice;
3. app restart and account switch do not couple text selection to voice session state;
4. a service with no MatrixRTC capability still provides complete text/community UX;
5. voice failure/crash is contained by a scoped boundary and does not take down the content pane.

Extend existing queue/sync behavior only where a demonstrated gap exists.

### A2-6 — WP-20: voice profiles, priority speaker, and whispers

This is post-A2-3 differentiator work, not a release blocker.

- Implement named Voice/Music profiles only through supported LiveKit/WebRTC codec controls and publish measured bandwidth, not TeamSpeak-derived promises.
- Keep forward-error-correction settings standards-compatible and test negotiation/fallback.
- Priority Speaker must be a permission-controlled, client-side ducking policy with an obvious local opt-out and accessibility-safe feedback.
- Whisper routing must preserve Matrix membership authorization and media E2EE. Do not route selective audio through the legacy P2P engine in a Matrix build.
- If LiveKit/MatrixRTC cannot express safe selective routing without a protocol extension, stop with a concrete design decision and threat model instead of shipping a local-only illusion.

### A2-7 — WP-25: reproducible resource budgets

Turn the existing runtime probe into repeatable evidence for:

- cold start to painted shell and interactive state;
- idle renderer/native RSS after a fixed settling interval;
- CPU wakeups/usage at idle;
- idle text sync, active voice, and screen-share cases;
- exact OS, hardware, build type, SHA, sample duration, and variance.

CI should enforce regression budgets on controlled runners where stable; platform-specific marketing comparisons belong in a separately reviewed report. Do not claim Discord’s current usage from an unverified secondary number.

## Verification

Run focused voice tests during implementation. Before declaring local source work complete, from `mesh/` run:

```powershell
npm run lint
npx tsc --noEmit
npm run test -- --maxWorkers=1
npm run build
npm run check:bundle-size
npm run check:ipc-contract
npm run check:ipc-types
npm run matrixrtc:preflight
npm run release:preflight

$env:CARGO_BUILD_JOBS='1'
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --no-default-features --features matrix-backend --all-targets --locked --jobs 1 -- -D warnings
npm run test:rust:matrix
npm run test:rust:legacy
```

Also run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File infra/matrixrtc/test-evidence-validation.ps1
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --features legacy-p2p --locked --jobs 1 --test turn_probe_live_tests
```

Environment-backed TURN/MatrixRTC cases are ignored unless explicitly configured. Report exact ignored/run counts. Do not count validator tests as live media evidence.

## Hard stops

Stop and report when completion needs:

- production DNS/TLS/router/firewall changes or host mutation;
- service/API credentials, signing keys, or new secrets;
- a recurring paid service or a change to the zero-cost product decision;
- physical devices/networks not provided;
- enabling voice/media-E2EE capability flags;
- a protocol extension that changes Matrix interoperability;
- push, deployment, release, or publication authority.

## Completion record

Append one entry per work package.

```text
### A2 report — [WP-ID]
Status: complete | partial | blocked
Files changed:
Behavior delivered:
Tests/commands and exact results:
Evidence class: mocked | local | disposable-live | physical-live | external
Physical matrix: N/23 run, N passed, N failed, N not-run
Capability flags changed: no (unless explicit authority and 23/23 evidence)
Deviations and why:
Remaining blocker:
Shared-file wiring required:
```

## Execution records - 2026-07-31

### A2 report - A2-0
Status: partial
Files changed: `mesh/scripts/beta-release-preflight.ps1`
Behavior delivered: Preserved the Matrix fail-closed baseline (`voice === false`, `media_e2ee_verified === false`) and tightened the release check so a Matrix frontend bundle containing any legacy SimplePeer implementation is rejected. The Rust Matrix dependency graph excludes `libp2p`; the legacy graph remains separately feature-gated.
Tests/commands and exact results: `npm run release:preflight` passed source validation. `powershell ... beta-release-preflight.ps1 -VerifyFrontendBundle` failed closed as intended because `dist/assets/voice-engine-t46SaEGf.js` (116.71 KiB) is present. `scripts/check-matrix-release-dependencies.ps1` passed the Rust Matrix boundary and reported the legacy-only vulnerable dependency set without claiming it fixed. The authenticated E2E Matrix text-send and media-disabled cases passed.
Evidence class: local
Physical matrix: 0/23 run, 0 passed, 0 failed, 23 not-run
Capability flags changed: no
Deviations and why: A fully separate Matrix frontend artifact could not be completed inside this lane because `package.json`, `vite.config.ts`, shared app imports, and build/release target wiring were explicitly read-only.
Remaining blocker: The Matrix release frontend still packages the lazy legacy voice engine. This is a hard release blocker even though the Rust Matrix graph is clean.
Shared-file wiring required: Add build-target-specific frontend/package/Vite wiring so the Matrix artifact cannot resolve or emit SimplePeer while the explicitly separate LAN artifact still can, then rerun `-VerifyFrontendBundle`.

### A2 report - WP-03
Status: partial
Files changed: `mesh/infra/matrixrtc/MatrixRtcEvidence.psm1`, `mesh/infra/matrixrtc/RUNBOOK.rst`, `mesh/infra/matrixrtc/acceptance-matrix.example.json`, `mesh/infra/matrixrtc/test-evidence-validation.ps1`, `mesh/scripts/matrixrtc-preflight.ps1`, `mesh/scripts/beta-release-preflight.ps1`, `mesh/src/components/voice/VoiceControls.tsx`, `mesh/src/components/voice/VoiceControls.test.tsx`, `mesh/src/lib/voice-runtime.ts`, `mesh/src/lib/voice-runtime.test.ts`
Behavior delivered: Documented and checked the public DNS, TLS, firewall, bounded-log, credential-rotation, and TURN UDP/TLS paths; retained identity/membership/epoch/permission/SFU binding and fail-closed media-E2EE requirements; mapped browser/platform media permission denial to a plain system-settings recovery action; and made evidence case-bound by exact device, network, transport, E2EE, SHA, timestamp, logs, and network results.
Tests/commands and exact results: `npm run matrixrtc:preflight` passed source-only validation and made no live claim. `infra/matrixrtc/test-evidence-validation.ps1` passed 20/20 positive and negative validator cases. Targeted voice runtime/control/engine tests passed 62/62 across 3 files. Full Vitest passed 674/674 across 93 files. `npm run build`, bundle budgets, 172-command IPC contract, generated IPC types, and source release preflight passed.
Evidence class: local
Physical matrix: 0/23 run, 0 passed, 0 failed, 23 not-run
Capability flags changed: no
Deviations and why: Production online preflight, TURN allocation/media, host deployment, DNS, TLS, and firewall mutation were not run because no approved infrastructure or credentials were supplied.
Remaining blocker: Owner-approved infrastructure, credentials, and physical devices/networks are required for live TURN and MatrixRTC acceptance.
Shared-file wiring required: Agent 1 must wire any required shared release/build target separation described in A2-0; no shared IPC/bridge/app/package files were edited here.

### A2 report - WP-04
Status: complete
Files changed: `mesh/src/lib/voice-engine.ts`, `mesh/src/lib/voice-engine.test.ts`, `mesh/src/lib/voice-peer.ts`
Behavior delivered: Recreates a closed `AudioContext` while still resuming a suspended one; stops every retained relay stream track before replacement, disconnect removal, topology rebuild, reset, or teardown; and removes the private SimplePeer `negotiate()` seam in favor of the documented public `addTrack()` renegotiation path.
Tests/commands and exact results: Focused `voice-engine.test.ts` passed 27/27, including closed-context recreation, public-track relay forwarding, repeated disconnect idempotence, and complete teardown. The full frontend suite passed 674/674. `npm run test:rust:legacy` passed 223 runnable tests with 19 explicit ignores.
Evidence class: local
Physical matrix: 0/23 run, 0 passed, 0 failed, 23 not-run
Capability flags changed: no
Deviations and why: This repair remains legacy-LAN-only and was not promoted into Matrix.
Remaining blocker: None for the scoped engine repair; the separate artifact packaging blocker is recorded under A2-0.
Shared-file wiring required: Keep the legacy engine reachable only from the explicit LAN build target when shared build wiring is split.

### A2 report - WP-05
Status: blocked
Files changed: `mesh/infra/matrixrtc/MatrixRtcEvidence.psm1`, `mesh/infra/matrixrtc/acceptance-matrix.example.json`, `mesh/infra/matrixrtc/test-evidence-validation.ps1`, `mesh/infra/matrixrtc/RUNBOOK.rst`
Behavior delivered: Hardened the checked-in 23-case physical schema and validator without fabricating results. Every case remains `not-run`. Passed cases must now prove case-bound devices, networks, direct or relayed transport as applicable, active media E2EE, failure-closed key rotation, bounded service/client/network evidence, exact SHA, and timestamps.
Tests/commands and exact results: Validator suite passed 20/20 and rejects wrong-device, missing-TURN, missing-E2EE, generic cross-case, missing-network-result, stale/future, dirty-source, wrong-SHA, and tampered evidence. Source MatrixRTC preflight passed. The physical/live suite was not run.
Evidence class: external
Physical matrix: 0/23 run, 0 passed, 0 failed, 23 not-run
Capability flags changed: no
Deviations and why: The hard stop requires owner-approved live infrastructure, at least two physical or faithfully isolated devices, and two independent networks including restrictive NAT/firewall coverage.
Remaining blocker: Execute and validate all 23 cases against the exact release SHA, then obtain an explicit owner release decision. Until then voice and media-E2EE remain unavailable.
Shared-file wiring required: None before physical execution; capability wiring is prohibited until the gate and explicit approval both pass.

### A2 report - WP-06
Status: blocked
Files changed: none for persistent voice rooms or sidebar occupancy
Behavior delivered: No post-gate occupancy or persistent-voice feature was started. Existing Matrix UI remains capability-gated and text remains usable while media is unavailable.
Tests/commands and exact results: The authenticated E2E case "shows MatrixRTC membership but never starts media while encryption is unverified" passed, as did Matrix text sending. The broader authenticated run was 20 passed / 5 failed; the failures are shared Agent-3 UI accessibility/focus regressions (`role=listitem` without a `list` parent and narrow room-context focus), not voice enablement.
Evidence class: local
Physical matrix: 0/23 run, 0 passed, 0 failed, 23 not-run
Capability flags changed: no
Deviations and why: The handoff forbids starting WP-06 until WP-05 establishes trustworthy physical MatrixRTC state.
Remaining blocker: WP-05 at 23/23 plus explicit owner approval, followed by current authenticated-membership occupancy and revocation testing.
Shared-file wiring required: Future work will require coordinated shared sidebar/content integration after the gate; none was authorized in this lane.

### A2 report - WP-07
Status: partial
Files changed: no shared text/queue/app files; existing acceptance coverage was executed
Behavior delivered: Verified that Matrix text and encrypted attachments remain usable with media unavailable, and that the disposable two-homeserver flow recovers offline text exactly once without joining voice.
Tests/commands and exact results: Authenticated E2E passed the Matrix text-send case, the fail-closed MatrixRTC membership case, and all 6/6 encrypted-DM/attachment cases. `npm run setup:matrix-spike:reset` plus `npm run test:matrix-spike` passed 2/2 disposable-live tests, including federated encrypted messaging, offline restart/catch-up exactly once, second-device historical room/DM decryption, account-data sync, and fresh community-hosted registration. The full authenticated E2E run was 20 passed / 5 failed due to the shared UI accessibility/focus regressions listed under WP-06.
Evidence class: disposable-live
Physical matrix: 0/23 run, 0 passed, 0 failed, 23 not-run
Capability flags changed: no
Deviations and why: Shared queue/sync/app/E2E files were read-only for this lane, so remaining one-to-one acceptance cases were not expanded here. The live spike logged a non-fatal Windows lock on one temporary SDK-store directory after secure keys were erased.
Remaining blocker: Repair the shared authenticated accessibility/focus failures and add explicit executable coverage for search/reactions/replies/edits/pins/account-switch independence if not already owned by the integration lane.
Shared-file wiring required: Agent 1/3 integration should repair the shared `ChatView` list semantics and narrow `RoomContextPanel` focus behavior without weakening voice fail-closed checks.

### A2 report - WP-20
Status: blocked
Files changed: none
Behavior delivered: No voice profiles, priority-speaker, whisper, codec, or selective-routing feature was started.
Tests/commands and exact results: Not applicable before the physical gate; baseline capability and dependency checks passed as recorded above.
Evidence class: external
Physical matrix: 0/23 run, 0 passed, 0 failed, 23 not-run
Capability flags changed: no
Deviations and why: This is explicitly post-WP-05 differentiator work, and safe MatrixRTC selective routing has not been established.
Remaining blocker: Complete WP-05, then produce a standards-compatible LiveKit/MatrixRTC design and threat model before implementation.
Shared-file wiring required: None until the post-gate design is approved.

### A2 report - WP-25
Status: partial
Files changed: `.github/workflows/nightly-soak.yml`, `mesh/e2e/runtime-budgets.spec.ts`, `mesh/scripts/resource-budget-probe.ps1`, `mesh/scripts/beta-release-preflight.ps1`
Behavior delivered: Added three-sample browser timing/DOM/heap/long-task/transfer evidence with exact SHA and machine metadata; added a fixed-duration native process-tree RSS/private-memory/CPU/context-switch probe for idle text sync, active voice, and screen share; and added a Windows nightly browser-evidence artifact. The native probe explicitly records that true CPU wakeups require ETW/WPA and does not substitute its context-switch proxy.
Tests/commands and exact results: Browser resource E2E passed 1/1 with 3 samples (painted 45/87/1943 ms; interactive 80/125/1994 ms; DOM 97; heap 12,700,000 bytes; long tasks 0; transfers 16,200/16,200/3,651,664 bytes). A native dirty-worktree smoke probe passed with exact SHA `b2427b637b659939bebb11ba620c8c434243acc9`, 5 samples, and `cpuWakeupsAvailable=false`. The production bundle budgets passed: entry 245.53/350 KiB, eager JS 434.72/525 KiB, all JS 1973.83/2048 KiB, CSS 80.15/100 KiB, fonts 332.28/400 KiB, all assets 2386.26/2500 KiB.
Evidence class: local
Physical matrix: 0/23 run, 0 passed, 0 failed, 23 not-run
Capability flags changed: no
Deviations and why: Browser numbers are Vite development-runner evidence, not a signed release benchmark. Native active-voice/screen-share samples and true Windows wakeups were not collected because physical media and an ETW/WPA owner run are gated.
Remaining blocker: Run the signed release artifact on controlled hardware for every scenario, collect ETW/WPA wakeups, define reviewed regression budgets from repeated clean-SHA baselines, and keep external competitor comparisons out until separately verified.
Shared-file wiring required: If release CI should enforce native budgets, add an approved signed-artifact launch target and controlled-runner policy in the shared release workflow.

### A2 verification summary

- `npm run lint`: passed with 0 errors and 2 warnings in shared `CommandPalette.tsx` / `InteractivePrimitives.tsx`.
- `npx tsc --noEmit`: passed.
- `npm run test -- --maxWorkers=1`: 93 files, 674 passed, 0 failed.
- `npm run build`: passed; Vite warned that the 533.41 KiB lazy LiveKit chunk exceeds 500 KiB.
- `npm run check:bundle-size`: passed all budgets.
- `npm run check:ipc-contract`: 3 checker tests passed; 172 commands matched.
- `npm run check:ipc-types`: passed and the checked-in DTO contract remained current.
- `npm run matrixrtc:preflight`: passed source-only; no production/live evidence collected.
- `npm run release:preflight`: passed source-only.
- `cargo fmt --check`: passed.
- Matrix clippy with `matrix-backend`, all targets, locked, one job, and `-D warnings`: passed.
- `npm run test:rust:matrix`: 170 runnable passed, 0 failed, 3 live-infrastructure tests ignored.
- `npm run test:rust:legacy`: 223 runnable passed, 0 failed, 19 ignored.
- Isolated `turn_probe_live_tests`: 2 passed, 0 failed, 3 credentialed/live probes ignored.
- Disposable Matrix federation/recovery: 2 passed, 0 failed.
- Strict Matrix frontend release-bundle boundary: failed closed on the 116.71 KiB `voice-engine` SimplePeer chunk.
- Authenticated Chromium E2E: 20 passed, 5 shared UI accessibility/focus failures; all Agent-2-critical cases passed.
- No files were staged, committed, pushed, deployed, or published.

### A2 follow-up - bridge resilience

Status: complete for the locally actionable bridge failure paths; live voice remains blocked by WP-05.
Files changed: `mesh/src/lib/bridge.ts`, `mesh/src/lib/bridge.resilience.test.ts`, `mesh/src/lib/bridge.voice-boundary.test.ts`, `mesh/src/lib/voice-engine.ts`, `mesh/src/lib/voice-engine.test.ts`
Behavior delivered: Browser preview retains an explicit STUN-only fixture, while Tauri ICE configuration failures now propagate to callers. ICE probe failures reach the existing diagnostics error/retry boundary instead of becoming an empty result. Non-serializable legacy signaling now returns a typed `serialization_error`, and outgoing signaling failures surface an actionable connection warning.
Tests/commands and exact results: Focused bridge/voice/error tests passed 76/76. Full Vitest passed 98 files / 707 tests. Affected diagnostics and voice Playwright specs passed 14/14. TypeScript, ESLint, Matrix build, strict frontend bundle preflight, bundle budgets, readiness-ledger validation, source release preflight, and `git diff --check` passed. The Matrix artifact contains no legacy voice assets.
Evidence class: local
Physical matrix: 0/23 run, 0 passed, 0 failed, 23 not-run
Capability flags changed: no
Deviations and why: The browser-only fallback remains for development preview because no native Tauri backend exists there; configured Tauri failures are no longer hidden. No live MatrixRTC behavior was enabled.
Remaining blocker: Owner-approved MatrixRTC/SFU/TURN infrastructure, two independent networks, physical-device evidence for all 23 cases, and explicit release approval remain required before voice capability flags change.
Shared-file wiring required: none

### A2 follow-up - WP-04 verification refresh

Status: verified complete; no additional code change was needed because the scoped legacy repair is already present in the current dirty worktree.
Tests/commands and exact results: Focused `voice-engine.test.ts` passed 28/28. `npm run build:lan` passed with the legacy `voice-engine` chunk at 116.77 KiB. A source scan found no direct `SimplePeer.negotiate()` call in `voice-engine.ts` or `voice-peer.ts`.
Evidence class: local
Physical matrix: 0/23 run, 0 passed, 0 failed, 23 not-run
Capability flags changed: no
Remaining blocker: WP-05 still requires owner-approved MatrixRTC/SFU/TURN infrastructure, two independent networks, physical-device evidence for all 23 cases, and explicit release approval. No later voice feature was started ahead of that gate.
Shared-file wiring required: none

### A2 follow-up - Rust feature quality gate

Status: complete for locally actionable Rust quality gates; external production gates remain unchanged.
Files changed: `mesh/src-tauri/src/**` and `mesh/src-tauri/tests/live_network_tests.rs` for lint-safe refactors and test cleanup only.
Behavior delivered: Preserved Matrix and legacy runtime behavior while making both feature graphs pass strict `-D warnings` Clippy, including all targets. Narrow `too_many_arguments` allowances remain only on existing Tauri/persistence signatures whose public shape is part of the current command/storage contract.
Tests/commands and exact results: `cargo fmt --all -- --check` passed. Matrix Clippy passed; legacy-p2p Clippy passed. Matrix Rust tests passed 169/169, with IPC contract 1/1, two additional runnable live-adjacent tests passed, and three infrastructure-dependent tests ignored. Legacy Rust tests passed 206/206, crypto integration 15/15, IPC contract 1/1, and auxiliary runnable tests passed; network/turn live tests remained expectedly ignored.
Evidence class: local
Physical matrix: 0/23 run, 0 passed, 0 failed, 23 not-run
Capability flags changed: no
Deviations and why: The legacy dependency graph still contains the separately reported `libp2p`, `hickory-proto 0.24.4`, `ring 0.16.20`, and `rustls-webpki 0.101.7` findings; the Matrix release graph excludes them and the cleanup does not claim those findings are fixed.
Remaining blocker: WP-05 live MatrixRTC/SFU/TURN acceptance, physical-device evidence, and signed release approval remain required before voice capability flags change.
Shared-file wiring required: none
