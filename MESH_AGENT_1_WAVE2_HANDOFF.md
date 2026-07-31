# Mesh Agent 1 wave-two handoff

Date: 2026-07-31

## Verdict

`LOCALLY_INTEGRATED_NOT_RELEASE_READY`

The required Agent 2 and Agent 3 handoffs were present, so Agent 1 completed
the final shared frontend/IPC integration barrier and the complete serialized
verification suite.

The work ran on `main` in a deliberately dirty shared worktree whose observed
base HEAD is `72f093c84621183073ec43e233cfe0a26a1ca5f2`. The integrated changes
do not have their own commit SHA. This is local engineering evidence, not
same-SHA CI, merge, signing, release, deployment, or public-download evidence.
Nothing was staged, committed, pushed, deployed, published, reset, stashed, or
cleaned.

## Root causes fixed

1. Browser sign-in could use one global `MESH_OAUTH_CLIENT_ID` after discovery
   of any provider. Production now resolves a public desktop client
   registration only for the exact canonical discovered issuer, using a
   versioned compile-time registry and the fixed
   `http://127.0.0.1:8418/oauth/callback`. Unknown issuers, aliases, duplicate
   issuers, invalid schema, missing capabilities, redirect variation, and
   missing configuration all fail closed.
2. External account creation did not have a durable, bounded return path tied
   to the selected account service and opaque invitation handle. The
   continuation now survives restart, expires, rejects replay/replacement, and
   is consumed only after password or browser authentication succeeds.
3. Account switching cleared visible room state but left Matrix notification,
   privacy/presence, recovery, sync-readiness, and in-flight preference state.
   The transition now invalidates old reads/writes, clears account-scoped
   settings and timers, preserves device-local appearance, and prevents an
   old account response from repopulating the next account.
4. Community role labels/templates could be mistaken for effective authority.
   Agent 3's per-room Matrix projection is now a shared Rust/IPC DTO and
   Matrix-only command. Role application requires current authoritative state,
   validates the actor/target/recovery path, and refreshes after writes.
5. Permission projection lacked runtime freshness. Typed native events now
   invalidate the active community on `m.room.power_levels` and
   `m.space.child` changes. Renderer reads use bounded IPC options,
   coalescing, a generation token, relevant-room filtering, and a 150 ms
   debounce; stale account/community results are rejected.
6. Permission failure UX had no integrated diagnostic surface. The People
   panel now lists each room's kind, bounded status, and plain failure reason
   without message content, credentials, or raw protocol dumps.
7. Release builds had no explicit issuer-registry input. The release workflow
   now accepts the reviewed non-secret
   `MESH_OAUTH_CLIENT_REGISTRATIONS_JSON` repository variable and preflight
   rejects the legacy global client ID. No provider ID or credential was
   invented.

## Shared integrations performed

- Preserved Agent 2's explicit Matrix presence write with rollback, bounded
  one-second `sync_once`, federation-test diagnostics, MatrixRTC evidence
  validation, release provenance, dependency-boundary, SBOM, artifact scan,
  signing, and draft-release controls.
- Preserved Agent 3's owner-only `m.room.power_levels` creation override and
  per-room moderation guards.
- Moved Agent 3 projection DTOs into `backend/mod.rs`, added the non-Matrix
  `Unsupported` trait default, implemented the Matrix trait call, registered
  `matrix_get_community_permission_projection` in both handler lists, exported
  the DTOs, and regenerated the TypeScript contract.
- Added the typed `matrix:permission-state-changed` backend-to-Tauri-to-renderer
  event.
- Added the bridge read/listener and integrated projection loading, retry,
  diagnostics, role-operation refresh, sync-event refresh, account restore,
  and community-switch invalidation.
- Reconciled the current readiness ledger in `PRODUCTION_BETA_PLAN.md`.

## Files changed or integrated

Identity, onboarding, and account isolation:

- `mesh/src-tauri/src/backend/matrix/oidc.rs`
- `mesh/src-tauri/src/backend/matrix/oidc/configuration.rs`
- `mesh/src/components/onboarding/MatrixAccountScreen.tsx`
- `mesh/src/components/onboarding/MatrixAccountScreen.test.tsx`
- `mesh/src/components/settings/SecurityDevicesPanel.tsx`
- `mesh/src/components/settings/SecurityDevicesPanel.test.tsx`
- `mesh/src/lib/registration-continuation.ts`
- `mesh/src/lib/registration-continuation.test.ts`
- `mesh/src/lib/account-transition.ts`
- `mesh/src/lib/account-transition.test.ts`
- `mesh/src/store/settings.ts`
- `mesh/src/store/settings.sync.test.ts`

Shared backend, permission projection, IPC, and renderer:

- `mesh/src-tauri/src/backend/mod.rs`
- `mesh/src-tauri/src/backend/matrix.rs`
- `mesh/src-tauri/src/backend/matrix/tests/mod.rs`
- `mesh/src-tauri/src/backend/matrix/moderation.rs`
- `mesh/src-tauri/src/backend/matrix/moderation/permission_projection.rs`
- `mesh/src-tauri/src/commands/backend.rs`
- `mesh/src-tauri/src/commands/notifications.rs`
- `mesh/src-tauri/src/lib.rs`
- `mesh/src-tauri/src/bin/export_ipc_types.rs`
- `mesh/src/types/ipc.generated.ts`
- `mesh/src/types/ipc.ts`
- `mesh/src/lib/bridge.ts`
- `mesh/src/lib/community-permissions.ts`
- `mesh/src/lib/community-permissions.test.ts`
- `mesh/src/components/community/RolePermissionPreview.tsx`
- `mesh/src/components/community/RolePermissionPreview.test.tsx`
- `mesh/src/components/community/MemberList.tsx`
- `mesh/src/components/community/MemberList.test.tsx`
- `mesh/src/components/community/RoomContextPanel.tsx`
- `mesh/src/hooks/useCommunityPermissionProjection.ts`
- `mesh/src/hooks/useCommunityPermissionProjection.test.tsx`

Release, RTC, federation, bundle, and readiness files from the combined
worktree were preserved and integrated:

- `.github/workflows/release-beta.yml`
- `mesh/scripts/beta-release-preflight.ps1`
- `mesh/scripts/matrixrtc-preflight.ps1`
- `mesh/scripts/check-matrix-release-dependencies.ps1`
- `mesh/scripts/scan-release-artifacts.ps1`
- `mesh/infra/matrixrtc/MatrixRtcEvidence.psm1`
- `mesh/infra/matrixrtc/RUNBOOK.rst`
- `mesh/infra/matrixrtc/acceptance-matrix.example.json`
- `mesh/infra/matrixrtc/test-evidence-validation.ps1`
- `mesh/src-tauri/tests/matrix_federation_live_tests.rs`
- `mesh/src/components/ui/Icon.tsx`
- `mesh/src/types/lucide-icons.d.ts`
- `mesh/vite.config.ts`
- `PRODUCTION_BETA_PLAN.md`

The existing `.gitignore`, product plans, and unrelated dirty paths were
preserved.

## OIDC registry and callback contract

Non-secret compile-time input:

- name: `MESH_OAUTH_CLIENT_REGISTRATIONS_JSON`
- current local bundle value: absent
- result while absent: browser sign-in fails closed with no provider
  registration
- schema:
  `{"version":1,"registrations":[{"issuer":"https://issuer.example/","clientId":"public-client-id","redirectUri":"http://127.0.0.1:8418/oauth/callback"}]}`
- maximum document size: 64 KiB
- maximum registrations: 32
- exact callback: `http://127.0.0.1:8418/oauth/callback`

No production issuer, client ID, signing key, reusable credential, dynamic
registration fallback, alias, or global fallback is present.

Every discovered issuer must advertise:

- authorization-code response type;
- query response mode;
- `authorization_code` grant;
- `refresh_token` grant;
- S256 PKCE.

## Focused verification

Passed before the final suite:

- six focused frontend files: 25 tests passed, 0 failed;
- final `cargo test ... --lib oidc --jobs 1`: 17 passed, 0 failed;
- `npm run generate:ipc-types`: generated current contract;
- `npm run check:ipc-contract`: 172 commands passed;
- `npm run check:ipc-types`: generated DTO parity passed;
- Windows PowerShell source preflight: passed.

The `pwsh` executable is not installed in this Windows environment. Running the
same preflight with the available `powershell -NoProfile -ExecutionPolicy
Bypass` host passed; this was an environment invocation correction, not a
product gate bypass.

## Final serialized verification

All commands ran sequentially from `mesh/` unless noted.

1. `npm ci`
   - 405 packages installed;
   - 406 packages audited;
   - 0 vulnerabilities.
2. `npm run lint`
   - passed with 0 errors and 0 warnings.
3. `npx tsc --noEmit`
   - passed.
4. `npm test -- --maxWorkers=1`
   - first integration run: 90 files passed, 1 file failed; 647 tests passed,
     1 failed;
   - root cause: the account-switch test's partial bridge mock did not include
     the settings bridge exports newly reached by complete renderer cleanup;
   - focused correction: `MatrixAccountScreen.test.tsx` passed 21/21;
   - final full rerun: 91 files and 648 tests passed, 0 failed.
5. `npm run e2e -- --workers=1`
   - 64 passed, 0 failed.
6. `npm run build`
   - passed; 1,072 modules transformed.
7. `npm run check:design-tokens`
   - passed; 53 Tailwind colors and all declared theme/density/typography roles
     resolved.
8. `npm run check:icons`
   - passed; production components use the central absolute-stroke renderer.
9. `npm run check:ipc-contract`
   - 3 checker tests passed;
   - 172 registered commands passed contract validation.
10. `npm run check:ipc-types`
    - generated Rust-to-TypeScript contract is current.
11. `npm run check:public-services`
    - 3 reviewed services checked with 0 errors.
12. `npm run check:public-site`
    - 9 pages and their local links/invitation/social contracts passed.
13. `npm run check:bundle-size`
    - passed every budget.
14. `npm audit`
    - 0 vulnerabilities.
15. `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
    - passed.
16. Matrix all-target Clippy with `--jobs 1 -- -D warnings`
    - passed with 0 warnings.
17. `npm run test:rust:matrix`
    - 164 library tests passed;
    - 1 generated-contract test passed;
    - 2 deterministic federation-harness helper tests passed;
    - 3 environment-backed tests remained explicitly ignored;
    - total executable pass count: 167; failures: 0.
18. `npm run test:rust:legacy`
    - 203 library tests passed;
    - 1 generated-contract test passed;
    - 15 crypto integration tests passed;
    - 2 deterministic TURN outcomes passed;
    - 19 live/soak/environment cases remained explicitly ignored;
    - total executable pass count: 221; failures: 0.
19. `npm run check:security-invariants`
    - Matrix: 19 passed, 0 failed;
    - legacy: 13 passed, 0 failed.
20. `git diff --check` from the repository root
    - passed.

Agent 2's disposable live systems, physical devices, signing, public download,
and operator gates were not rerun, as required by the Agent 1 plan.

## Current runtime and bundle values

Playwright runtime sample:

- ready: 168 ms;
- DOM nodes: 97;
- heap: 11,200,000 bytes;
- long tasks: 0 ms;
- transferred: 3,614,767 bytes.

Production budgets:

- entry JavaScript: 201.80 / 350.00 KiB;
- eager JavaScript: 514.13 / 525.00 KiB;
- all JavaScript: 1,967.16 / 2,048.00 KiB;
- CSS: 74.52 / 100.00 KiB;
- fonts: 332.28 / 400.00 KiB;
- all production assets: 2,373.96 / 2,500.00 KiB.

The largest emitted JavaScript asset is the lazy LiveKit voice chunk at
533.41 kB (139.53 kB gzip). Eager JavaScript has 10.87 KiB of remaining
headroom, so C1-C5 work should preserve lazy boundaries.

## Provider and session evidence

Proven deterministically:

- exact loopback method, host, port, path, state, request-size, timeout,
  cancellation, malformed-input, duplicate-parameter, and one-time callback
  behavior;
- distinct canonical issuers resolve only their own public client IDs;
- missing registry, missing issuer registration, invalid registry, redirect
  mismatch, aliases, duplicate issuers, and each missing native capability fail
  closed without exposing a client ID;
- selected-service and opaque invitation continuation survives restart and
  failed authentication, expires, rejects replay/replacement, and is consumed
  only after success;
- secure session storage remains native; no password, token, client secret,
  room alias, or full invitation crosses the continuation store;
- account A renderer state and account-scoped preferences cannot repopulate
  account B after a stale in-flight read;
- account removal copy truthfully describes local-device removal rather than
  remote provider deactivation.

Not proven live:

- provider-owned registration and redirect approval;
- first browser sign-in in a clean signed installer;
- provider cancellation, refresh-token expiry/renewal, restart restoration,
  local logout, provider revocation or logout-everywhere;
- second-device verification/recovery and clean-device residue inspection.

OIDC must remain capability-gated.

## Community permission and account-isolation evidence

The integrated frontend and Rust tests prove:

- Matrix default, Mesh-created, divergent, manually edited, federated,
  inaccessible, unsupported, failed, and incomplete room authority remains
  distinguishable;
- unknown authority cannot enable role Apply;
- self-assignment, protected-creator demotion, equal/greater-authority edits,
  escalation, and last-recovery-path removal fail closed;
- the projection traversal is cycle-safe and capped at 2,048 rooms;
- remote power-level/Space-child changes refresh only the relevant active
  community after a bounded debounce;
- an older account/community generation cannot overwrite a newer projection;
- room, channel, DM, message, typing, draft, media, pin, voice, network,
  selection, modal, notification, privacy/presence, backup, and sync state is
  cleared on account transition;
- pending invitation and device appearance remain intentionally preserved.

No message plaintext, credentials, provider secret, or direct renderer network
request was added to this path.

## Peer live evidence kept separate

Agent 2 observed the same base HEAD and recorded two independent disposable
reset/live cycles after its final explicit-presence fix:

- cycle 1: 2 passed, 0 failed; federation/recovery 179,634 ms; fresh
  registration 7,012 ms;
- cycle 2: 2 passed, 0 failed; federation/recovery 179,408 ms; fresh
  registration 6,892 ms.

Those runs covered encrypted federation, stale `m.direct`, directory/knock/join,
presence, room metadata/power levels, encrypted messages/media/pins, offline
delivery/catch-up, fresh-device recovery/decryption, account data, upgrades,
moderation, and audit. They occurred before Agent 1's final uncommitted
integration and therefore are not represented as same-source final-barrier
evidence.

Agent 2 also recorded:

- RTC evidence validator: 15 passed, 0 failed;
- focused voice frontend: 42 passed;
- Rust voice boundary: 1 passed;
- Matrix all-target Clippy: passed.

All 23 physical/network MatrixRTC cases remain `not-run`.
`BackendCapabilities.voice` remains false,
`VoiceServiceAvailability::ClientUnavailable` remains enforced, and
media-E2EE readiness remains unsupported.

Agent 3's C0 runtime hooks are now integrated. Its requested post-integration
live compatible-client acceptance was not available. C1-C5 remain not started.

## Unresolved external blockers

- A clean commit containing the integrated worktree and protected
  same-SHA CI/security evidence.
- Provider-owned public desktop client registrations and redirect approval.
- Authorized real-provider session lifecycle, revocation, recovery, and clean
  signed-device evidence.
- Trusted LiveKit authorization/SFU/TURN, physical Windows devices, controlled
  networks/NAT, active media E2EE/key rotation/revocation, and a reviewed second
  compatible client.
- Production DNS/TLS/federation, optional Mac mini or other operator service,
  backups/restores, monitoring, quotas, disk/clock alarms, incident response,
  containment, and rollback.
- A non-placeholder application version, publisher identity, signing
  certificate, release credentials, signed MSI/NSIS installers, SBOM and
  provenance review, attestations, draft release, and canonical public-download
  verification.
- Legal/privacy/security/support/abuse review and public Pages publication.
- C1 guided entry, C2 forums/events, C3 integrations, C4 expression features,
  and C5 cache/i18n/mobile prerequisites and implementation.

Do not enable OIDC or voice, weaken authority/encryption/provenance gates, or
call this worktree production-ready to bypass those blockers.
