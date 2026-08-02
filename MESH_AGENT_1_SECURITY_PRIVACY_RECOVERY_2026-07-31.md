# Mesh Agent 1 — Security, Privacy, Recovery, and Final Integration

**Date:** 2026-07-31
**Run on:** `main` only
**Starting documentation SHA:** `b2427b6`
**Integrated implementation SHA:** `7effb0c`
**Master plan:** `MESH_SOL_PRODUCTION_IMPLEMENTATION_PLAN_2026-07-31.md`

## Mission

Close WP-09 through WP-12, WP-21, and WP-24 without weakening Matrix interoperability, then act as the final shared-integration owner after Agents 2 and 3 have finished. The result must make recovery, moderation, privacy, notifications, and invitations safe for strangers—not merely green under mocks.

WP-00 and WP-01 are complete on `main`. Do not rebuild or revert the WAVE2 integration.

## Read first

1. `AGENTS.md`
2. `PRODUCTION_BETA_PLAN.md`, especially the 2026-07-31 ledger and stop conditions
3. `MESH_SOL_PRODUCTION_IMPLEMENTATION_PLAN_2026-07-31.md`
4. This file
5. Current `git status`, `git log -5 --oneline`, and the exact source/tests you will change

Source wins over every document. Audit before adding code: parts of WP-09, WP-11, WP-12, and WP-21 already exist.

## Parallel-work contract

- Work directly on the existing `main` checkout. Do not create/switch branches, reset, clean, stash, or overwrite concurrent work.
- Do not stage, commit, push, deploy, or publish unless the user explicitly authorizes that action in your task.
- Agents 2 and 3 may be editing the same worktree. Preserve every unrelated dirty path.
- During the parallel phase, Agent 2 exclusively owns:
  - `mesh/src-tauri/src/backend/matrix.rs`
  - `mesh/src-tauri/src/backend/matrix/rtc.rs`
  - `mesh/src/lib/livekit-voice.ts`, `mesh/src/lib/voice-engine.ts`
  - `mesh/src/components/voice/**`, `mesh/src/store/voice.ts`
  - `mesh/infra/matrixrtc/**`
  - release/voice workflows and operator scripts
- Agent 3 exclusively owns:
  - `mesh/vite.config.ts`
  - `mesh/src/styles/**`
  - general community/onboarding/navigation UI and accessibility E2E files
- Agent 1 owns recovery/privacy/notification/invite/security leaf modules, their focused UI/tests, and `.github/workflows/security.yml`.
- Shared hot files—`App.tsx`, `bridge.ts`, generated IPC types, `src-tauri/src/lib.rs`, `backend/mod.rs`, package manifests, and `PRODUCTION_BETA_PLAN.md`—are read-only during parallel work. Add isolated leaf modules and record the required wiring. Agent 1 may integrate them only after both other agents mark their completion records ready.
- Do not create a separate handoff file. Append evidence to this file under “Completion record.”

## Required implementation order

### A1-0 — Audit and close only real deltas

Create a short checked table in the completion record for WP-09/10/11/12/21/24 with `complete`, `partial`, or `missing`, citing source and tests. In particular, verify:

- Matrix recovery health and explicit recovery consent already exist.
- read receipts already default off and have public/private/off modes;
- typing already defaults off;
- notification previews already cross a native boundary;
- v5 invitations already separate account service, community routing, admission, and resume state;
- no AI feature currently has network inference or send/moderation authority.

Do not replace working behavior just to match wording in the audit.

### A1-1 — WP-09: recovery that is stored safely and proves it works

Primary files include:

- `mesh/src-tauri/src/backend/matrix/encryption.rs`
- the Matrix recovery functions currently in `mesh/src-tauri/src/backend/matrix.rs`—defer edits until Agent 2 releases that file
- `mesh/src-tauri/src/crypto/keychain.rs`
- `mesh/src/components/settings/SecurityDevicesPanel.tsx`
- `mesh/src/components/onboarding/OnboardingFlow.tsx`
- their existing tests and generated IPC contract if the API changes

Acceptance criteria:

1. Recovery remains explicit opt-in and Matrix-compatible.
2. The primary save path uses the operating system credential store. Never write the recovery secret to logs, diagnostics, analytics, localStorage, a notification, test output, or an unencrypted file.
3. Do not claim generic password-manager insertion unless a reviewed platform API actually performs it. Copy, QR, or encrypted file alternatives may be offered, but they must be honest and accessible.
4. Validate Matrix recovery-key format/checksum using the SDK or specification-compatible implementation; do not invent a second incompatible recovery format.
5. A health check proves a real decrypt/restore round trip against a bounded encrypted canary or equivalent SDK-backed proof. “Key exists” is not sufficient.
6. A background check must remain bounded, local, non-notifying, and secret-safe. If the credential store is locked, present an actionable state rather than prompting repeatedly.
7. Fresh-device recovery must continue decrypting historical encrypted rooms and DMs, including edits and replies. Preserve the already-passing two-homeserver recovery suite.
8. No raw public key is presented as the user’s identity. Human-readable identity and deterministic visual identity remain primary.

### A1-2 — WP-10: make ban and recovery different by construction

Model the distinction at three layers and test every one:

| Event | Wire/control-plane signal | Local state transition | Other-user UI |
|---|---|---|---|
| legitimate device recovery | trusted device/cross-signing/recovery event | identity retained or explicitly re-verified | advisory device/recovery notice |
| community ban | Matrix membership/moderation state plus the existing cryptographic enforcement appropriate to that backend | access and new-key delivery revoked | explicit moderation/ban state |

Requirements:

- Do not encode a recovery as a ban, a ban as a generic identity change, or either as an ambiguous “security changed” event.
- Keep community-wide moderation auditable and represented on the Matrix control plane.
- Preserve standard Matrix membership semantics and compatible-client behavior.
- Add pure transition tests, backend boundary tests, renderer copy tests, and a compact wire/UI table to the completion record.
- If the legacy P2P key-rotation ban and Matrix moderation cannot share one wire model safely, keep the feature boundary explicit rather than inventing false equivalence.

### A1-3 — WP-11: reciprocal, per-conversation receipt and typing privacy

The current global defaults are already off. Extend only the missing behavior:

1. Add a per-conversation override with an account-scoped default of off.
2. Display another participant’s typing or public read state only when the local user has opted to share the corresponding signal in that same conversation.
3. Do not turn private Matrix receipts into a visible “seen by” signal.
4. Turning a signal off must clear any locally published typing state and prevent future publication.
5. Account switching must generation-invalidate all privacy state and cannot restore settings from the previous account.
6. A remote peer must not learn a new local status merely because the local client queried or rendered their status.
7. Document the limit honestly: Mesh controls its own publication and display behavior; it cannot force arbitrary compatible clients to implement reciprocity.

Add migration tests, room/DM tests, account-switch race tests, and renderer tests. Do not expose Matrix terminology in the default setting copy.

### A1-4 — WP-12: notification content minimization

Audit the complete path from Matrix sync event to native OS notification.

Acceptance criteria:

- Default title/body contains the sender’s safe display identity and a generic “New message” statement, never message text, attachment names, decrypted reply text, room topic, or secret-bearing error detail.
- Full-content preview is a separate explicit opt-in with a lock-screen/mirroring warning.
- The preference is account-scoped, defaults false on fresh and migrated installs, and is cleared correctly on account switch.
- Protected-room and active-room suppression continue to work.
- Notification test fixtures must not contain real secrets or direct contact details.

### A1-5 — WP-21: signed, revocable invitations without presence leakage

Build on invitation v5; do not rebuild it.

Acceptance criteria:

1. Existing-account and separately hosted-account users still join through federation without moving their account.
2. Invitation authenticity, expiry, replay, explicit discard, and restart-safe resume remain tested.
3. Any live occupancy preview is returned only for an active, revocable invite and is bounded/coarsened. Possession of an expired, revoked, replayed, or scraped URL must not become a presence oracle.
4. If no trustworthy server-authoritative/revocable occupancy proof exists, omit live occupancy rather than trusting inviter-supplied counts.
5. Invitation metadata never contains access tokens, recovery secrets, raw device keys, TURN credentials, or private room history.
6. The fallback site/deep-link behavior remains compatible.

### A1-6 — WP-24: enforce the on-device/non-autonomous AI boundary

Add a small, behavior-oriented CI check and architecture note:

- production code must not add third-party inference endpoints or AI provider SDKs without an explicit reviewed allowlist change;
- AI code cannot invoke message-send, invite, kick, ban, role, or moderation commands;
- optional local captions or local models must be feature-gated, off by default, disclose resource use, and never silently download a model;
- false positives must be narrow and reviewed—do not make the check a brittle keyword scan over documentation.

Wire the check into `.github/workflows/security.yml` and add positive/negative fixture tests.

### A1-7 — Final three-lane integration barrier

Begin only after Agents 2 and 3 have appended complete evidence to their own briefs.

1. Review `git status --short` path by path and map every change to one lane.
2. Reject edits outside ownership unless the originating agent documented the coordination.
3. Integrate deferred shared-file wiring in the smallest possible patches.
4. Regenerate IPC types once, after all command/DTO changes.
5. Run `git diff --check`, search for conflict markers, secrets, placeholders, raw public-key UI, and accidentally enabled voice flags.
6. Run the full serialized matrix below.
7. Update `PRODUCTION_BETA_PLAN.md` once with exact current-SHA evidence and remaining external gates. Do not add another status document.
8. Leave the worktree uncommitted unless the user explicitly authorizes a commit.

## Verification

Run focused tests after each package. Before final integration, from `mesh/` run serially:

```powershell
npm ci
npm run lint
npx tsc --noEmit
npm run check:ipc-contract
npm run check:ipc-types
npm run check:security-invariants
npm run check:design-tokens
npm run check:icons
npm run test -- --maxWorkers=1
npm run build
npm run check:bundle-size
npm run e2e -- --workers=1
npm audit --audit-level=high
npm run check:public-services
npm run check:public-site

$env:CARGO_BUILD_JOBS='1'
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --no-default-features --features matrix-backend --all-targets --locked --jobs 1 -- -D warnings
npm run test:rust:matrix
npm run test:rust:legacy
```

Run `npm run setup:matrix-spike:reset` followed by `npm run test:matrix-spike` twice from independent resets if recovery, invitations, Matrix account data, moderation, or federation behavior changed. Report environment-backed tests as local disposable-live evidence, not public-provider evidence.

## Hard stops and external gates

Stop and report instead of guessing when work requires:

- provider account creation, CAPTCHA, terms acceptance, or production OAuth registration;
- new secrets, signing keys, updater keys, or production service credentials;
- DNS/router changes, Mac mini mutation, service deployment, or recurring paid infrastructure;
- a change to account-service choice, community/account separation, or Matrix interoperability;
- legal/trademark conclusions;
- claiming public release, OIDC, recovery, or MatrixRTC readiness without live evidence.

## Completion record

Append one entry per work package; do not create another Markdown file.

```text
### A1 report — [WP-ID]
Status: complete | partial | blocked
Files changed:
Behavior delivered:
Tests/commands and exact results:
Evidence class: mocked | local | disposable-live | physical-live | external
Deviations and why:
Remaining blocker:
Shared-file wiring required:
```

### A1-0 audit — current source

| Checked | Work package | Status | Source and focused evidence |
|---|---|---|---|
| [x] | WP-09 recovery | partial | Explicit opt-in is enforced in `mesh/src/components/onboarding/OnboardingFlow.tsx`; SDK-backed health and restore exist in `mesh/src-tauri/src/backend/matrix.rs`; locked/missing secure-store states are distinguished in `mesh/src-tauri/src/crypto/keychain.rs`. The generated backup code is still returned to the renderer and is not saved to the OS credential store. |
| [x] | WP-10 ban vs recovery | partial | Recovery calls the Matrix SDK recovery API; community bans use standard room membership bans plus `org.mesh.moderation.audit.v1` records in `mesh/src-tauri/src/backend/matrix/moderation.rs`. New boundary and renderer-copy tests prevent those paths from collapsing, but no cross-user recovery advisory event is projected yet. |
| [x] | WP-11 receipt and typing privacy | partial | `mesh/src/store/settings.ts` and Matrix `WirePrivacyPreferences` default receipts and typing off, preserve public/private/off receipt modes, and publish typing-off cleanup. Per-conversation overrides and reciprocal display gating are absent. |
| [x] | WP-12 notification minimization | complete | Native policy and active/muted-room suppression remain intact. The trusted boundary defaults to a safe sender plus `New message`, removes remote avatars, and releases a bounded sanitized message preview only after an explicit account-scoped opt-in that defaults off across fresh, migrated, and switched accounts. |
| [x] | WP-21 invitations | partial | Version 5 parsing keeps account service, community routing, admission, and resume separate in `mesh/src/lib/community-invites.ts`; encrypted restart-safe pending state, expiry, take/discard, and claim behavior exist in the Matrix backend. Occupancy is omitted and new tests reject presence/secret-bearing metadata. A cryptographically signed invitation payload is still absent. |
| [x] | WP-24 AI boundary | complete | The production tree contains no AI feature. `mesh/scripts/check-ai-boundary.mjs` now enforces an empty reviewed network-provider allowlist, local-only AI module contracts, no network/model auto-download path, and no send/invite/kick/ban/role/moderation authority. Positive and negative fixtures run in `security.yml`. |

### A1 report — WP-09
Status: partial
Files changed: none; shared Matrix recovery wiring remains deferred
Behavior delivered: Audited and preserved explicit recovery consent, Matrix-compatible SDK recovery, 90-day health freshness, server-backup checks, secret zeroization in the test path, and actionable locked credential-store errors. Rejected a command-boundary save that could enable remote recovery and then lose the only visible code when the OS credential store is locked.
Tests/commands and exact results: `npx vitest run ... OnboardingFlow.test.tsx BackupCodeScreen.test.tsx ... --maxWorkers=1` was part of 10 files / 56 tests passed; Matrix `cargo test ... crypto::keychain::tests` passed 3/3.
Evidence class: local
Deviations and why: The OS-store primary save, checksum-specific UI validation, and bounded background round-trip remain a cohesive follow-up DTO/API tranche. They were not partially wired during final integration because enabling remote recovery and then losing the only visible code when the OS secure store is locked would strand the user. The existing explicit consent and passing SDK recovery path were preserved.
Remaining blocker: Return the one-time code together with an account-scoped OS-store result, retain SDK-format validation, add a bounded non-notifying canary/restore proof, and run two fresh reset federation/recovery cycles plus a genuinely fresh physical/virtual device.
Shared-file wiring required: Add the recovery setup/result DTO to `backend/mod.rs`, save from `matrix.rs` using an account-scoped keychain name, expose it through the typed command/bridge/generated IPC contract, and update onboarding/settings copy for locked-store recovery without generic password-manager claims.

### A1 report — WP-10
Status: partial
Files changed: `mesh/src-tauri/src/backend/matrix/moderation.rs`; `mesh/src/components/settings/SecurityDevicesPanel.test.tsx`; `mesh/src/lib/moderation.test.ts`
Behavior delivered: Added a backend contract test proving recovery uses the SDK recovery path while a ban uses Matrix membership `ban_user`; renderer tests keep re-check-device advisory copy distinct from explicit ban copy. Existing community-wide room outcomes and moderation audit records remain unchanged.
Tests/commands and exact results: Matrix `cargo test ... backend::matrix::moderation::tests` passed 8/8; focused Vitest passed 3 files / 47 tests.
Evidence class: local
Deviations and why: No new cross-user wire event was invented. Matrix membership bans and legacy P2P key rotation remain explicit feature boundaries.
Remaining blocker: Add a typed trusted-device/recovery advisory projection and pure account-state transitions for other-user surfaces; test member list, system notice, and notification behavior end to end.
Shared-file wiring required: A typed recovery advisory DTO/event requires coordinated changes to `backend/mod.rs`, `matrix.rs`, event registration, generated IPC, `bridge.ts`, and the consuming shared UI after the other lanes finish.

Wire/UI distinction retained:

| Event | Wire/control-plane signal | Local transition | Other-user copy |
|---|---|---|---|
| Legitimate device recovery | Matrix SDK recovery plus cross-signing/device trust | identity retained or explicitly re-checked | advisory: the sign-in changed and should be checked |
| Community ban | Matrix room membership ban across the Space/child rooms plus moderation audit | access revoked; standard membership state remains authoritative | explicit removed/prevented-from-rejoining ban state |

### A1 report — WP-11
Status: partial
Files changed: none
Behavior delivered: Audited and preserved account defaults of receipts off and typing off, public/private/off receipt semantics, account-switch preference invalidation, and required typing-off cleanup.
Tests/commands and exact results: Focused privacy/recovery Vitest passed 10 files / 56 tests; Matrix `cargo test ... privacy` passed 4/4.
Evidence class: local
Deviations and why: No renderer-only override was added because it could disagree with backend publication state and create a false privacy guarantee.
Remaining blocker: Per-conversation account-data overrides, reciprocal remote typing/public-read display, DM and room coverage, and generation-race coverage. Mesh can control only its own publication/display and cannot require compatible clients to reciprocate.
Shared-file wiring required: Extend `UserPreferences` and Matrix account-data normalization with bounded per-room overrides, apply effective policy inside `mark_read`, `set_typing`, and `typing_users`, regenerate IPC once, then add focused controls to the shared conversation UI.

### A1 report — WP-12
Status: complete
Files changed: `mesh/src-tauri/src/backend/mod.rs`; `mesh/src-tauri/src/commands/notifications.rs`; `mesh/src-tauri/tests/matrix_federation_live_tests.rs`; `mesh/src/store/settings.ts`; `mesh/src/store/settings.test.ts`; `mesh/src/store/settings.sync.test.ts`; `mesh/src/hooks/useNotificationSync.ts`; `mesh/src/hooks/useNotificationSync.test.tsx`; `mesh/src/components/settings/UserSettingsPanel.tsx`; `mesh/src/components/settings/UserSettingsPanel.test.tsx`; `mesh/src/types/ipc.generated.ts`
Behavior delivered: Before emitting a notification to the renderer or OS, Mesh now defaults to `New message`, removes the remote avatar, normalizes/bounds the sender label, and titles the native notification `New message from <safe name>`. A separate account-scoped `Show message text` opt-in warns about lock screens, mirrored displays, and notification history. Fresh, migrated, reset, and switched accounts fail closed to false. Even when enabled, the native boundary strips control/Bidi characters, collapses whitespace, limits the preview to 180 characters, and never restores the remote avatar. Active-room, mute, quiet-hours, do-not-disturb, and fail-closed startup suppression remain intact.
Tests/commands and exact results: Matrix notification tests passed 7/7 and legacy notification tests passed 7/7. Focused frontend integration passed 7 files / 72 tests. Full Vitest passed 98 files / 697 tests; Playwright passed 65/65; both complete Rust feature suites and both independently reset disposable Matrix cycles passed.
Evidence class: local
Deviations and why: Full content remains deliberately bounded and sanitized rather than exposing an unbounded decrypted event payload. The preference is portable account data so account switches are generation-invalidated; the OS notification surface remains the only content-release decision point.
Remaining blocker: Physical lock-screen, notification-history, and display-mirroring acceptance on supported operating systems remains part of release validation.
Shared-file wiring required: none

### A1 report — WP-21
Status: partial
Files changed: `mesh/src/lib/community-invites.test.ts`
Behavior delivered: Added explicit v5 rejection coverage for live occupancy, member identities, access tokens, recovery material, raw device keys, voice credentials, and private history. Mesh continues to omit occupancy because there is no trustworthy server-authoritative revocable proof.
Tests/commands and exact results: Focused invite/moderation/device Vitest passed 3 files / 47 tests, including all seven new metadata rejection cases.
Evidence class: local
Deviations and why: No inviter-supplied occupancy count or unsigned authenticity field was added.
Remaining blocker: Define and verify a cryptographically signed, revocable server-authoritative invitation contract if the existing HTTPS origin-bound one-use admission service is insufficient; only then consider a bounded/coarsened occupancy proof.
Shared-file wiring required: Any signed invitation schema or occupancy proof requires coordinated admission-service, Matrix backend, DTO/IPC, fallback-site, and deep-link changes after the other lanes finish.

### A1 report — WP-24
Status: complete
Files changed: `mesh/scripts/check-ai-boundary-lib.mjs`; `mesh/scripts/check-ai-boundary.mjs`; `mesh/scripts/check-ai-boundary.test.mjs`; `mesh/scripts/fixtures/ai-boundary/**`; `mesh/docs/architecture/on-device-ai-boundary.rst`; `.github/workflows/security.yml`
Behavior delivered: Added a behavior-oriented production-source and manifest check. Known network AI dependencies/endpoints require an explicit reviewed allowlist change; AI modules must be local-only, feature-gated, resource-disclosing, and non-downloading; network primitives and send/invite/kick/ban/role/moderation calls are rejected. The check excludes prose and generated/test trees.
Tests/commands and exact results: `node --test scripts/check-ai-boundary.test.mjs` passed 3/3 positive/negative fixtures; `node scripts/check-ai-boundary.mjs` passed the real production tree.
Evidence class: local
Deviations and why: The check is wired directly in `security.yml` because package manifests are shared and read-only during parallel work.
Remaining blocker: Protected CI must run the check on the eventual integrated SHA; any future local model still needs product UI/resource acceptance.
Shared-file wiring required: none

### A1 report — final three-lane integration barrier
Status: complete
Files changed: `PRODUCTION_BETA_PLAN.md`; shared WP-12 files listed in its report; `mesh/src-tauri/tests/matrix_federation_live_tests.rs` preference fixtures
Behavior delivered: Waited for both companion completion records, mapped every dirty path to Agent 1, Agent 2, Agent 3, or preserved pre-existing user state, accepted only documented shared-file coordination, integrated the account-scoped notification-content DTO/settings/UI boundary, regenerated IPC types, and updated the production ledger once. No unrelated root deletion, ignore change, plan source, or lane-owned behavior was reverted.
Tests/commands and exact results: `npm ci` audited 406 packages; audit found 0 vulnerabilities. Lint and TypeScript passed. Design, icons, 172-command IPC, generated DTO, AI boundary, public-service, public-site, source release, and MatrixRTC source preflight passed. Vitest passed 98 files / 697 tests; Playwright passed 65/65. Build and all configured budgets passed (245.78 KiB entry, 434.97 KiB eager JS, 1,989.49 KiB all JS, 80.41 KiB CSS, 332.28 KiB fonts, 2,402.18 KiB total). Matrix/legacy security filters passed 19/13. Format and all-target Matrix Clippy passed with warnings denied. Full Matrix and legacy commands passed. Two independent reset/live cycles each passed 2/2. `git diff --check`, conflict-marker, Agent-1 secret/placeholder, raw-public-key UI, and voice-capability scans found no new violation.
Evidence class: local
Deviations and why: Verification ran on an uncommitted dirty worktree based on `b2427b637b659939bebb11ba620c8c434243acc9`; the base SHA does not identify the integrated changes. The strict Matrix frontend bundle check intentionally remains red because the emitted 116.71 KiB legacy `voice-engine` chunk violates the release boundary.
Remaining blocker: Commit-authorized protected same-source CI is still required. Product work remains under WP-09, WP-10, WP-11, and WP-21; MatrixRTC needs 23/23 physical evidence; accessibility needs manual AT/target-webview coverage; release still needs OIDC/provider, operator, signing, legal, publication, and public-download evidence.
Shared-file wiring required: deferred WP-09/WP-10/WP-11/WP-21 integrations listed above; WP-12 has none

### A1 report - verdict follow-up
Status: complete for locally specifiable work; blocked only on reviewed protocol/product contracts and external release evidence
Files changed: `.github/workflows/security.yml`; `mesh/package.json`; `mesh/vite.config.ts`; `mesh/src-tauri/tauri.legacy.conf.json`; `mesh/scripts/check-ai-boundary-lib.mjs`; `mesh/src-tauri/Cargo.lock`; `mesh/src-tauri/src/backend/mod.rs`; `mesh/src-tauri/src/backend/matrix.rs`; `mesh/src-tauri/src/commands/backend.rs`; `mesh/src-tauri/tests/matrix_federation_live_tests.rs`; `mesh/src/store/settings.ts`; `mesh/src/components/settings/SecurityDevicesPanel.tsx`; `mesh/src/components/settings/UserSettingsPanel.tsx`; `mesh/src/components/navigation/RoomTabStrip.tsx`; `mesh/src/components/layout/AppLayout.tsx`; generated IPC and focused tests
Behavior delivered: Closed the remaining local dependency, Matrix-bundle, keyboard, room-tab privacy, mention-count, AI-manifest-parser, Windows account-erasure, secure recovery, and per-conversation privacy findings. Recovery now has account-scoped protected storage, typed health/verification, bounded saved-copy proof, and complete local erasure. Typing and receipts now have bounded Matrix account-data overrides with backend-effective publication and reciprocal display policy. The Matrix production bundle contains no SimplePeer implementation; LAN mode remains explicit and separate.
Tests/commands and exact results: TypeScript, ESLint, formatting, Matrix all-target Clippy with warnings denied, 173-command IPC, generated DTO, design/icon, AI (4/4 plus real tree), public-service, public-site, Matrix build/budgets/strict bundle boundary, explicit LAN build, `npm audit` (0), workflow-equivalent `cargo audit`, admission service (9/9), Vitest (98 files / 702), Playwright (66/66), complete Matrix and legacy Rust suites, and Matrix/legacy security filters passed. Two independent post-fix reset Matrix cycles passed 2/2; the final rerun completed in 211.72 seconds with strict Windows cleanup.
Evidence class: local plus disposable-live
Deviations and why: No cross-user recovery advisory, signed invitation wire format, advanced-permission protocol, or channel-lifecycle scheduler was invented because their Matrix/federation/product semantics are not approved. The worktree remains uncommitted and dirty, so the base SHA identifies only the starting source and protected same-SHA CI is not claimed.
Remaining blocker: Reviewed protocol/product decisions for recovery advisories, signed/revocable invitations, advanced permissions, and lifecycle/retention; 23/23 physical MatrixRTC evidence; manual assistive-technology/target-webview evidence; production OIDC/provider, operator, signing, legal, publication, and public-download evidence.
Shared-file wiring required: none until those contracts are decided
