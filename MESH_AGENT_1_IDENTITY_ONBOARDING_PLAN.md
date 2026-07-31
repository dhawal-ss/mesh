# Mesh Agent 1 - remaining identity, onboarding, and final integration

## Mission

This is the second-wave brief. Do not redo the work already present in the
dirty worktree. Finish the remaining identity and onboarding defects, prove the
native OAuth/session lifecycle, and perform the final repository reconciliation
only after Agents 2 and 3 have stopped editing.

The required consumer path remains:

1. install Mesh;
2. open an invitation;
3. explicitly choose an account service;
4. create an account or sign in; and
5. enter the invited community.

Account hosting and community hosting are separate. Do not force an invitee to
create an account on the community's service, silently choose a service, or
describe Matrix infrastructure in the normal flow.

Read before changing anything:

- `AGENTS.md`
- `MESH_COMPETITIVE_PRODUCTION_PLAN_2026-07-30.md`
- `PRODUCTION_BETA_PLAN.md`
- the complete current `git status` and diffs for every file you intend to edit

## Verified starting point and known failures

The first wave already added:

- replay-resistant browser-registration continuation;
- invitation/service restoration after an external registration handoff;
- renderer account-state cleanup during account switching;
- stricter loopback OAuth callback parsing, timeout, and one-use behavior;
- clearer local account-removal language and focused tests.

The post-wave audit passed lint, TypeScript, 90 Vitest files / 637 tests,
64 Playwright scenarios, the production build and bundle gate, 156 Matrix Rust
tests plus the generated contract check, legacy tests, security invariants, and
one clean two-homeserver federation/recovery run.

Do not call that production-ready. The following remain:

1. Strict Matrix Clippy fails in
   `mesh/src-tauri/src/backend/matrix/oidc.rs` because the nested `Host` header
   check is a `collapsible_if` warning.
2. OIDC readiness still depends on one global `MESH_OAUTH_CLIENT_ID`. It is not
   configured by provider/issuer in production, and no release evidence proves
   a real provider lifecycle.
3. Installed, signed browser-registration and invitation-resume acceptance is
   missing.
4. Password and OIDC refresh, restart, logout, revocation, second-device, and
   clean-device local-removal acceptance remain unproven.
5. `PRODUCTION_BETA_PLAN.md` currently overstates the first-wave integration as
   locally complete even though strict Clippy failed and the second live reset
   did not complete deterministically.

Treat these statements as an audit snapshot and reverify them against the
current checkout before acting.

## Parallel ownership contract

All three agents may be using the same dirty `main` checkout.

- Do not create a branch, stage, commit, push, deploy, release, reset, stash,
  clean, or discard changes.
- Preserve all tracked and untracked work.
- Before every edit, run `git diff -- <path>` and reread the file.
- Do not run a repository-wide formatter.
- During parallel work, run focused tests with one worker. Do not run full
  Vitest, Playwright, builds, Clippy, or live Matrix tests while another agent
  is compiling or resetting infrastructure.
- Rust commands must use `--jobs 1` or `CARGO_BUILD_JOBS=1`.
- If an owned file contains new edits you cannot attribute to this lane, stop
  and record an integration request rather than overwriting it.

### Files owned during the parallel phase

- `mesh/src-tauri/src/backend/matrix/oidc.rs`
- new OIDC configuration leaf modules and their tests under
  `mesh/src-tauri/src/backend/matrix/`
- `mesh/src/components/onboarding/**`
- `mesh/src/components/settings/SecurityDevicesPanel.tsx`
- `mesh/src/components/settings/SecurityDevicesPanel.test.tsx`
- `mesh/src/lib/account-transition.ts`
- `mesh/src/lib/account-transition.test.ts`
- `mesh/src/lib/registration-continuation.ts`
- `mesh/src/lib/registration-continuation.test.ts`
- identity/onboarding leaf modules and tests newly created by this lane
- `mesh/src/config/public-services.json`
- `mesh/src/config/public-services.ts`
- `mesh/src/config/public-services.test.ts`

### Read-only until the final integration barrier

Agent 2 owns `mesh/src-tauri/src/backend/matrix.rs`, backend voice/RTC code,
release workflows, operational scripts, Cargo manifests, and infrastructure.
Agent 3 owns community, chat, permission, forum, expression, and moderation
files.

The following are shared integration files and must not be edited until Agents
2 and 3 have produced their completion handoffs:

- `mesh/src/App.tsx`
- `mesh/src/lib/bridge.ts`
- `mesh/src/types/ipc.generated.ts`
- `mesh/src-tauri/src/backend/matrix.rs`
- `mesh/src-tauri/src/lib.rs`
- `mesh/src-tauri/src/commands/**`
- `mesh/src-tauri/Cargo.toml`
- `mesh/src-tauri/Cargo.lock`
- `mesh/package.json`
- `mesh/package-lock.json`
- `.github/workflows/**`
- `PRODUCTION_BETA_PLAN.md`

## A0 - repair the authoritative local gate

Fix the strict-Clippy failure in `oidc.rs` without weakening callback
validation.

Acceptance:

- duplicate `Host` headers are still rejected;
- wrong host, port, path, method, request size, timeout, state, and replay are
  still rejected;
- `cargo fmt --check` passes;
- Matrix Clippy passes with `-D warnings` once the parallel compile window is
  clear.

This is a release-gate repair, not permission to suppress the lint or add an
allow attribute.

## A1 - replace the global OIDC client assumption

Implement a typed, fail-closed provider registration model.

Requirements:

1. Key public client registrations by the canonical discovered issuer, not by
   a user-entered display name or homeserver string.
2. Support distinct public client IDs for different issuers. A client ID for
   provider A must never be sent to provider B.
3. Bind every entry to Mesh's exact native loopback redirect URI and require
   authorization-code flow, query response mode, refresh-token grant where
   advertised, and S256 PKCE.
4. Reject duplicate issuers, malformed IDs, issuer mismatch, redirect mismatch,
   ambiguous aliases, unsupported metadata, and missing production
   configuration.
5. Keep client IDs outside the renderer. Client IDs are not secrets, but tokens,
   code verifiers, refresh credentials, and reusable bearer material must stay
   behind the Rust/native boundary and OS credential store.
6. Preserve "Use another service." An unregistered compatible service may use
   password login or external registration, but OIDC must remain visibly
   unavailable rather than borrowing another provider's registration.
7. Keep any legacy single-client environment variable disabled for production
   or narrowly scoped to an explicit development mode. Document the migration.
8. Add sanitized diagnostics that name the failed capability or missing
   operator registration without exposing tokens or raw callback data.

Prefer a small OIDC configuration module with unit tests. During the parallel
phase, do not edit `matrix.rs`; provide the exact function call and type that
the final barrier must wire into readiness and login.

Acceptance:

- tests cover two issuers with different IDs and prove there is no cross-use;
- issuer normalization cannot turn two different authorities into one;
- missing or invalid registration fails closed;
- no reusable secret appears in renderer props, browser storage, logs, or IPC;
- the release handoff tells Agent 2 exactly which non-secret build inputs and
  provider registrations are required.

## A2 - prove registration resume and account isolation

Build on the first-wave continuation and account-transition modules.

Complete and test:

- installed-app browser-registration return for Matrix.org and at least one
  additional reviewed service;
- invitation preservation across external browser handoff, app restart, login,
  token refresh, and an initially failed login attempt;
- expiration, replay, malformed data, cancellation, and explicit discard;
- custom compatible service behavior;
- account A to community B federation semantics;
- account-switch cleanup for rooms, DMs, drafts, notifications, presence,
  selected IDs, pending media, and any identity-scoped caches;
- removal of only the selected local account's stores, OS credentials, cached
  data, and pending continuation state;
- truthful distinction between "remove from this device" and remote account
  deactivation/deletion.

Do not automate a provider website, scrape credentials, embed a third-party
registration form, or claim an external account exists before authentication
succeeds.

Acceptance:

- a clean installed build resumes the original invitation and selected service;
- removing account A leaves account B usable;
- switching identities cannot flash or leak A's content into B;
- replayed or expired state fails closed with one actionable recovery choice;
- a clean-device residue inspection finds no secrets or selected-account data
  after local removal.

If signed installers or provider-owned configuration are unavailable, finish
all deterministic local work and record the exact external acceptance case as
blocked. Do not substitute a dev-server test for installed-app evidence.

## A3 - production OIDC/session lifecycle acceptance

Use real provider accounts only when credentials and provider registration are
explicitly available. Never create accounts, change provider configuration, or
revoke a real user's sessions without authorization.

Required matrix:

- first sign-in through the system browser;
- callback cancellation and timeout;
- state mismatch, nonce mismatch, wrong origin/path/port, duplicate callback,
  oversized request, and replay rejection;
- access-token expiry followed by refresh;
- restart with secure session restoration;
- local logout;
- provider revocation or "sign out everywhere" where supported;
- second-device verification and recovery;
- invitation context retained through recoverable failures;
- no reusable credential crosses renderer IPC.

Keep OIDC capability-gated until every production-provider case has evidence.

## A4 - final integration barrier

Run this only after these files exist and say their parallel work is complete:

- `MESH_AGENT_2_WAVE2_HANDOFF.md`
- `MESH_AGENT_3_WAVE2_HANDOFF.md`

If either is absent, write `MESH_AGENT_1_WAVE2_HANDOFF.md` with
`READY_FOR_FINAL_BARRIER` and stop. Do not poll indefinitely or edit shared
files.

At the barrier:

1. Read both handoffs and the complete dirty-tree diff.
2. Apply only their explicit shared-file integration requests.
3. Wire the issuer-scoped OIDC configuration into `matrix.rs`.
4. Register any completed Agent 3 command/IPC leaf APIs.
5. Regenerate IPC types with `npm run generate:ipc-types` and review the diff.
6. Reconcile release configuration requests with Agent 2 without inventing
   provider IDs, signing keys, or secrets.
7. Rewrite the current readiness ledger in `PRODUCTION_BETA_PLAN.md` so local,
   live, signed-release, and external/operator evidence are separate.
8. Remove the false "locally complete" claim unless every listed local gate
   has actually passed on the current source state.

Do not enable OIDC or voice because an interface exists. Capability availability
must follow evidence.

## Verification

During parallel leaf work:

```powershell
cd mesh
npx vitest run src/components/onboarding/MatrixAccountScreen.test.tsx src/lib/registration-continuation.test.ts src/lib/account-transition.test.ts src/components/settings/SecurityDevicesPanel.test.tsx --maxWorkers=1

$env:CARGO_BUILD_JOBS='1'
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --features matrix-backend --locked --jobs 1 oidc
```

At the final barrier, run sequentially:

```powershell
cd mesh
npm ci
npm run lint
npx tsc --noEmit
npm test -- --maxWorkers=1
npm run e2e -- --workers=1
npm run build
npm run check:design-tokens
npm run check:icons
npm run check:ipc-contract
npm run check:ipc-types
npm run check:public-services
npm run check:public-site
npm run check:bundle-size
npm audit

$env:CARGO_BUILD_JOBS='1'
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --no-default-features --features matrix-backend --all-targets --locked --jobs 1 -- -D warnings
npm run test:rust:matrix
npm run test:rust:legacy
npm run check:security-invariants

git diff --check
```

Do not rerun Agent 2's live, physical-device, signing, public-download, or
operator gates merely to produce another local pass. Cite its exact source SHA
and evidence, or keep the gate open.

## Stop conditions

Stop and report, rather than guess, when work requires:

- provider-owned client registration or redirect approval;
- real-account creation, logout-everywhere, or destructive revocation;
- a signing identity, release secret, or production credential;
- a shared file still being edited by Agent 2 or Agent 3;
- destructive reset of real user data;
- weakening OIDC, invitation, recovery, or encrypted-media security;
- calling a dirty or uncommitted source state "same-SHA CI."

## Required handoff

Create `MESH_AGENT_1_WAVE2_HANDOFF.md` containing:

- files changed;
- root causes fixed;
- focused and final commands with exact pass/fail counts;
- provider/session cases proven locally and live;
- proof that renderer/account isolation holds;
- shared integrations performed;
- current bundle values;
- unresolved external blockers;
- an explicit verdict: `READY_FOR_FINAL_BARRIER`, `LOCALLY_INTEGRATED_NOT_RELEASE_READY`,
  or `BLOCKED`, with reasons.

Never claim production readiness without signed public artifacts, clean-device
acceptance, production-provider identity evidence, Agent 2's live RTC/operator
evidence for any enabled voice feature, and truthful completion of every stop
condition in the competitive production plan.
