# Mesh: Production Beta Implementation Plan

**Prepared:** 2026-07-29
**Audience:** An autonomous coding agent (and human reviewers) picking up engineering work on Mesh
**Purpose:** Translate a full-codebase production-readiness review into a prioritized, actionable backlog that moves Mesh from "first successful manual E2E run" to a real production beta.

---

## Current verified readiness ledger

**Evidence date:** 2026-07-30
**Branch:** `main`
**Phase 0 implementation SHA:** `67b1ec80d90d9f1e4d016fea8984a14b06b2d37a`
**Phase 0 main merge SHA:** `12f451dca133f4d7658e42a7930614691b27a299`
**Z1-Z8 implementation SHA:** `f5edcee861e6244efe2aeee4d13ee67ee38d1384`
**Z1-Z8 main merge SHA:** `9fcc5c3aaefdca8923ec916b786a0134d5b2d5e9`
**Implementation state:** Z0-Z8 engineering is complete and merged. All seven
protected checks and two independently reset federation/recovery runs passed on
the exact Z1-Z8 implementation SHA. Public beta publication remains gated on
the owner-operated and external approvals listed below.

This section is the current source of truth. The detailed workstream review below
is retained as the original `2ca3dcc` audit baseline, so statements there that
describe invitations, deep links, account removal, export, rate-limit cleanup,
or test counts as missing are historical rather than current.

### Phase 0 implementation

| Gate | Current result | Evidence |
| --- | --- | --- |
| Cold-start invitation contract | Locally complete | `mesh/e2e/authenticated-shell.spec.ts` now asserts `matrix_join_community` arguments and the resulting active community/room. `mesh/src/App.tsx` makes initialization cancellation-safe and prevents a stale StrictMode snapshot from overwriting the joined invitation. |
| Secret scanning | Locally complete | `.github/workflows/security.yml` preserves verified/unknown scanning in two passes: all non-URI detectors plus URI-only scanning with the exact fixture paths in `.trufflehog-uri-excludes`. Credential-shaped invalid-URL fixtures are constructed without detector-shaped literals. TruffleHog 3.90.6 reported 0 verified and 0 unverified findings in both history passes and across 516 source/config chunks in the worktree. |
| Cross-platform Matrix reset | Complete | `mesh/scripts/run-matrix-spike-reset.mjs` selects `powershell.exe` on Windows and `pwsh` elsewhere. The protected Ubuntu workflow and two independently reset federation/recovery workflow runs passed on the Phase 0 implementation SHA. |
| Compact onboarding | Locally complete | `mesh/src/components/onboarding/OnboardingFlow.tsx` owns vertical scrolling instead of clipping the account path. `mesh/e2e/onboarding-accessibility.spec.ts` covers 800x500, 800x600, 1100x700, 200% zoom, keyboard reachability, managed account creation, password sign-in, browser sign-in, saved-account switching, custom service, validation, and invitation-prefilled onboarding. |
| React lint debt | Locally complete | Effect/state transitions were made derived, keyed, event-driven, or cancellation-safe across the affected chat, community, onboarding, settings, layout, and presence components. `npm run lint` passes with zero warnings and no blanket disables. |
| Accessibility regression | Locally complete | The create-room form no longer fades essential text through a transient low-contrast state. The focused Community Settings WCAG test passed 3 consecutive runs and the complete Playwright suite passed afterward. |

### Verification evidence

All commands below ran from `mesh/` against the current worktree:

- Dependency install/audit: `npm ci` and `npm audit --audit-level=high` passed; 406 packages audited, 0 vulnerabilities.
- Static/contract gates: TypeScript, zero-warning ESLint, 161-command Tauri IPC contract, generated IPC DTO parity, security invariants, design tokens, and icon contract all passed.
- Frontend tests: 71 files and 512 Vitest tests passed.
- Browser acceptance: 63 Playwright tests passed with one worker and no retries. This includes the cold invitation join and all compact onboarding cases.
- Production build: `npm run build` passed. The entry budget passed at 308.88 KiB; the broader all-chunk performance budget remains a P1 item.
- Admission service: 8 Python tests passed.
- Rust quality: `cargo fmt --check` and Matrix `cargo clippy --all-targets -- -D warnings` passed.
- Matrix Rust tree: 137 library tests plus the generated-contract test passed. The two disposable federation/recovery tests then passed twice from independently reset two-homeserver environments: 784.76 seconds and 781.33 seconds.
- Legacy Rust tree: 200 library tests, the generated-contract test, 15 crypto integration tests, and 2 deterministic TURN-probe outcomes passed. Environment-gated network/soak/TURN tests remained ignored by design.
- Dependency boundary: the Matrix production tree excludes `libp2p` and the enumerated legacy advisory crates. `cargo audit` completed with no unignored vulnerability failure; its 27 allowed warnings remain maintenance debt.
- Secret classification: the non-URI history pass scanned 211 chunks and the narrow URI pass scanned 208 chunks; both reported 0 verified and 0 unverified secrets. Bounded source/config scans covered 516 chunks and also reported 0/0.

### Phase 0 exit status

**Closed.** Pull request
[#7](https://github.com/dhawal-ss/mesh/pull/7) contains the final Linux reset
repair at exact implementation SHA
`67b1ec80d90d9f1e4d016fea8984a14b06b2d37a`. All seven required PR checks passed,
and the disposable federation/recovery workflow passed twice from independent
resets:

- [CI on the main merge](https://github.com/dhawal-ss/mesh/actions/runs/30502532197)
- [Security on the main merge](https://github.com/dhawal-ss/mesh/actions/runs/30502532188)
- [Federation/recovery run 1](https://github.com/dhawal-ss/mesh/actions/runs/30498875355)
- [Federation/recovery run 2](https://github.com/dhawal-ss/mesh/actions/runs/30500453223)

The reviewed implementation is reachable from `main`; the temporary protected-CI
branch was deleted after merge.

### Z1-Z8 engineering tranche

The following implementation is complete and merged into `main`. The evidence
below was collected from the exact implementation SHA before merge.

| Area | Implemented result | Current evidence |
| --- | --- | --- |
| Z1/Z3 service choice | Matrix.org is prominent but never automatic; tchncs.de and quassel.io are reviewed public options; invitation-provided and arbitrary compatible services remain first-class. Catalog data includes operator/policy/limit/review metadata and expires for re-review. Only the selected service is probed. | Catalog/schema, onboarding, stale-selection, custom-service, keyboard, zoom, and live discovery checks pass. Live discovery returned Matrix client versions and password/SSO/token login methods for all three entries on 2026-07-29. |
| Z2 account-independent invitations | Version 5 invitations separate room routing, community metadata, admission, and resume state. Versions 3/4 remain compatible. Existing or separately hosted accounts join directly through federation and fall back to knock; community registration is optional and never receives an account access token. Pending links are encrypted in a native, keychain-backed, 30-day store; the renderer receives only opaque metadata until an immediate join attempt, and failed joins remain restart-safe. | Unit/browser/Python compatibility tests pass, including secret-free metadata, expiry, explicit discard, and cold-start join acceptance. The disposable two-homeserver live suite passed twice from independent resets on the implementation SHA. |
| Z4 optional community hosting | The reference homeserver is explicitly community-hosted/BYOH with no SLA, token-only registration by default, an emergency registration switch, rate/media/retention/abuse guidance, and registration-control tests. Backup source excludes restorable one-time-key rows, applies bounded local/offsite retention, omits the standalone operator environment, requires identity-matched mode-600 recovery input, and fails closed before a live federated rollback without explicit owner acknowledgment. | Local Python and shell validation pass, including integrity, retention, tamper, and secret-boundary tests. The launchd template is source-only. Stock Synapse's lack of per-user media quotas is documented honestly. Mac mini mutation, off-host restore, DNS/router, and live federation remain owner-operated gates. |
| Z5 zero-cost distribution | A static public site, invitation fallback, service/privacy/terms/security/support/status pages, social asset, manual Pages workflow, and manual unsigned developer-preview workflow are source-complete. Release checks require signed Windows artifacts, SBOM, provenance, and public-boundary validation. | Public-site and source-release preflight pass. Pages is not deployed; privacy/terms remain drafts; the preview is explicitly unsigned and is not a beta release. Updater remains disabled without a signing key and public endpoint. |
| Z6 identity/recovery | Saved service identity, browser/password session handling, secure local removal, personal-data export, device recovery, and service-specific limitations remain separated from community routing. Undecryptable encrypted events remain visible in timeline order with bounded product-facing reason categories and contextual device-security help. | Unit/Rust/browser gates pass. Real public-provider account creation, legal acceptance, OIDC lifecycle, and clean-device provider recovery require owner-controlled accounts. |
| Z7 voice | MatrixRTC stays capability-gated and fails closed unless the advertised focus, SFU, membership freshness, and verified media-E2EE requirements are satisfied. Text/community use remains available without voice. | Rust and browser boundaries pass. Trusted MatrixRTC/LiveKit/TURN acceptance on physical devices and two networks remains a live external gate. |
| Z8 wider-beta hardening | Symbol-name checks were replaced by 18 Matrix and 13 legacy behavior tests. All production assets have budgets. Room/member/DM lists are virtualized to 5,000 items with bounded DOM, keyboard focus, and screen-reader ordering. Standard Matrix event reporting includes provider-aware abuse routing and plaintext disclosure. | 555 Vitest tests, 64 Playwright scenarios, WCAG scans, Rust suites, bundle checks, and a runtime probe pass locally. Invited-beta metrics and operator incident/restore exercises remain external gates. |

The 2026-07-29 release-time operator review reconfirmed Matrix.org's current
plan limits and the current tchncs.de and quassel.io policies. quassel.io's
catalog metadata was corrected to reflect its current German server and backup
locations. nope.chat is not included because its live Matrix registration
endpoint reports registration disabled. Unredacted remains usable through
**Use another service** but is deferred from the deliberately small initial
checked-in catalog; adding it later requires the same release-time operator,
policy, registration, and capability review.

Current local release-gate snapshot:

- TypeScript and zero-warning ESLint passed.
- 555/555 Vitest tests and 64/64 Playwright scenarios passed with bounded workers.
- Runtime probe: 281 ms ready, 87 DOM nodes, 15.2 MB heap, 64 ms long
  task, and 4,066,081 transferred bytes.
- Production budgets passed: 330.10 KiB entry, 462.23 KiB eager JavaScript,
  1,883.70 KiB all JavaScript, 67.64 KiB CSS, 332.28 KiB fonts, and
  2,283.63 KiB total assets.
- Matrix clippy passed with warnings denied; 146 Matrix Rust tests and 221
  executable legacy Rust tests passed.
- The 169-command IPC contract, generated IPC DTOs, design tokens, icon
  contract, public site, live public-service check, release source preflight,
  and high-severity npm audit all passed.

### Z1-Z8 exit status

**Closed.** Pull request
[#8](https://github.com/dhawal-ss/mesh/pull/8) merged the exact implementation
SHA `f5edcee861e6244efe2aeee4d13ee67ee38d1384` to `main` as
`9fcc5c3aaefdca8923ec916b786a0134d5b2d5e9`.

- [Protected CI](https://github.com/dhawal-ss/mesh/actions/runs/30516636447):
  all four jobs passed, including Linux and Windows Matrix, frontend/browser,
  and legacy Rust.
- [Security and feature boundary](https://github.com/dhawal-ss/mesh/actions/runs/30516636419):
  all three jobs passed, including dependency and two-pass history-secret scans.
- [Federation/recovery run 1](https://github.com/dhawal-ss/mesh/actions/runs/30516637145):
  2/2 live tests passed in 743.14 seconds.
- [Federation/recovery run 2](https://github.com/dhawal-ss/mesh/actions/runs/30516638106):
  2/2 live tests passed in 738.77 seconds from a separate reset.

No Pages deployment, release tag, signed installer publication, updater
activation, provider account creation, Mac mini mutation, DNS/router change, or
production MatrixRTC activation was performed.

## Zero-cost service decision (authoritative)

**Decision date:** 2026-07-29

This decision supersedes every historical item below that requires a paid,
centrally managed Mesh homeserver or moving the Mac mini to paid infrastructure.

- Mesh will not require a paid Mesh-operated service.
- Account hosting and community hosting are separate choices. A person may use
  an account from Matrix.org or another compatible service and join a community
  whose rooms are hosted on the Mac mini through federation.
- Matrix.org is the first prominent public-service option, but Mesh must not
  silently create an account there, imply that Matrix.org operates or endorses
  Mesh, or describe it as a Mesh-managed service.
- The Mac mini remains an optional community-hosted/bring-your-own service. It
  has no uptime SLA and must never be presented as the universal production
  default. An invitation may recommend it when a community owner intentionally
  permits account creation there.
- "Use another service" is a first-class path. It must accept a Matrix user ID
  or compatible service URL/domain, perform `.well-known` discovery, and
  support password, browser/SSO, and external-registration flows according to
  the selected service's advertised capabilities.
- Mesh may ship a small, checked-in catalog of additional public services. Each
  entry is an independently operated option, not an endorsement. Never import
  or mirror a community server directory wholesale at runtime.
- Runtime discovery and health requests must be limited to the service the user
  selected. Do not fan out probes to every catalog entry or disclose the user's
  IP address to services they did not choose.
- Public-service availability, registration policy, legal terms, attachment
  limits, and login methods can change. Catalog entries require a source,
  operator, jurisdiction if known, terms/privacy links, registration link,
  capability summary, `lastReviewedAt`, and an expiry/re-review rule.
- Matrix.org currently documents a free plan with a 10 MB maximum attachment
  and 100 MB daily upload allowance. Treat these as reviewed metadata, not
  timeless constants, and re-verify them before each release.
- Zero monetary hosting cost does not waive security, backup, abuse-prevention,
  privacy, release-signing, or honest-availability requirements.

The first implementation task is to update `AGENTS.md`, onboarding copy, and
release terminology so "managed Mesh service" no longer means one hard-coded
homeserver. Use the following four concepts consistently:

1. **Public service** - an independently operated Matrix service such as
   Matrix.org.
2. **Community-hosted service** - the Mac mini or another service offered by a
   community owner.
3. **Another service** - any compatible homeserver selected by the user.
4. **Community home service** - the server(s) needed to locate and federate the
   invited room; this is not necessarily where the invitee's account lives.

## Completed implementation record and remaining owner gates

Z0-Z8 were executed in order and are closed in the readiness ledger above. The
phase detail below is retained as an implementation and acceptance record, not
as instructions to restart completed work. Preserve unrelated worktree changes,
including `meshlogo.png`. Do not publish, deploy, rotate secrets, create
provider accounts, or mutate the Mac mini without explicit authorization.

### Z0 - Close the existing Phase 0 worktree on one SHA

**Implementation**

- Review the current uncommitted Phase 0 changes and remove only generated or
  accidental artifacts.
- With authorization, commit the reviewed changes directly to `main`, push the
  exact commit, and run all required GitHub CI, security, Windows release, and
  Ubuntu federation jobs against that same SHA.
- Record the commit and workflow links in the readiness ledger. Local results
  are not substitutes for same-SHA CI.

**Exit criteria**

- The Phase 0 code exists in one reviewable commit on `main`.
- Every required workflow is green on that exact commit, or the phase remains
  open with the exact failing job and log excerpt recorded.

### Z1 - Split the service model and build service selection

**Implementation**

- Remove the compile-time assumption that
  `https://matrix.mesh.dhawal.org` is the recommended account service from
  `MatrixAccountScreen.tsx`, `matrixSignIn.ts`, `matrix.rs`, and
  `.github/workflows/release-beta.yml`.
- Do not replace that value with Matrix.org in the existing
  `MESH_MANAGED_HOMESERVER`/`MESH_MANAGED_SERVER_NAME` variables. Split the
  concepts instead:
  - checked-in public-service catalog;
  - currently selected account service;
  - invitation/community home service and `via` servers;
  - optional community admission/registration service.
- Add a typed, checked-in catalog. Matrix.org is the required first entry.
  Catalog data is descriptive and reviewable; credentials, tokens, and dynamic
  health state never belong in it.
- Redesign the first account screen around explicit choices:
  - **Matrix.org** - public service, independently operated;
  - **More public services** - curated list with operator and policy details;
  - **Community-hosted service** - shown when an invitation/config supplies it;
  - **Use another service** - user-entered Matrix ID or service.
- Make no automatic selection that has account-creation or legal consequences.
  Explain in plain language that the service stores account data and may set
  its own rules and limits.
- Reuse the existing secure custom-service normalization and `.well-known`
  discovery. Continue rejecting credential-bearing URLs and non-loopback HTTP.
- Query the selected service's Matrix versions, login flows, registration
  capability, and relevant advertised limits. Render only supported actions:
  password sign-in, browser sign-in, or an external account-creation link.
- Persist the selected account service with the saved session. Never reinterpret
  it from a later invitation.

**Tests**

- Unit-test catalog schema validation, expiry, duplicate domains, HTTPS rules,
  legal/registration links, and safe custom-service normalization.
- Add browser tests for each service card, keyboard/zoom access, password
  login, browser login, external registration, a service with closed
  registration, an offline service, and arbitrary `.well-known` discovery.
- Add Rust tests proving account-service and community/admission-service
  configuration cannot be conflated.

**Exit criteria**

- A fresh user can choose Matrix.org, another curated public service, an
  invitation-supplied community service, or an arbitrary compatible service.
- The UI never calls an independently operated service "Mesh-managed".
- Only the selected service is probed at runtime.

### Z2 - Make invitations account-service independent

**Implementation**

- Remove the onboarding rejection that treats an invitation for a different
  service as invalid. A Matrix.org account must be able to join a room hosted
  by the Mac mini when federation and room policy allow it.
- Version the invitation payload without breaking existing `mesh://join`
  links. The new contract must distinguish:
  - room/community identifier;
  - `via` servers used to locate the room;
  - optional community home-service display metadata;
  - optional admission service and one-use registration token;
  - optional HTTPS fallback/resume identifier.
- Treat a community registration token as an offer to create an account on that
  community's service, not as a requirement. If the user chooses Matrix.org or
  another service, do not send that token anywhere; authenticate there and then
  join or knock on the invited room through federation.
- For an existing signed-in account, skip account creation and attempt the
  join/knock immediately. For a new account, retain the unconsumed invitation
  across browser registration, app restart, install, and protocol-handler
  activation.
- Keep admission tokens one-use, expiring, audience-bound, redacted from logs,
  and accepted only by their issuing community service.
- Convert federation failures into plain, actionable states: service
  unreachable, room not federated, invitation expired, membership denied, or
  registration required. Preserve diagnostic details behind an advanced
  disclosure.

**Tests**

- Cover Matrix.org-account-to-Mac-mini-room, Mac-mini-account-to-public-room,
  arbitrary-service-to-Mac-mini-room, saved-account reuse, join-versus-knock,
  expired/replayed token, service offline, federation denied, cold start, warm
  start, external registration resume, and legacy invitation compatibility.
- Add a disposable two-homeserver live test that proves the account service and
  room home service can differ. Keep real public-service acceptance low-volume,
  non-destructive, and compliant with that operator's terms.

**Exit criteria**

- An invitation routes the user to the community without forcing the user's
  account to live on the community's server.
- A clean installed Windows VM can open the HTTPS fallback, install Mesh, resume
  the same invitation, sign in to a chosen service, and land in the community.

### Z3 - Curate additional public-service options

**Implementation**

- Use public server directories only to discover candidates. Before adding an
  entry, verify it directly against its operator-owned site and Matrix
  endpoints.
- Candidate seeds for manual review include `tchncs.de`, `unredacted.org`,
  `nope.chat`, and `quassel.io`. Their presence here is not approval to ship
  them; availability and policies must be rechecked during implementation.
- Store at least: stable ID, display name, account domain, homeserver URL,
  operator, country/jurisdiction if published, registration method/link,
  login methods, terms, privacy policy, support/status links, free-use limits,
  notes, source URLs, and review/expiry timestamps.
- Add `npm run check:public-services` as a bounded release-time validation job.
  It should validate schema and selected public endpoints, produce a review
  report, and fail on expired metadata or unsafe URLs. Network failure must not
  silently rewrite the catalog.
- Require human review for additions/removals. Hide or mark an expired entry
  unavailable until it is reviewed; custom-service entry must always remain.
- Display a neutral disclaimer: public services are independently operated and
  may change availability, registration rules, content policies, and limits.

**Exit criteria**

- Matrix.org plus at least two directly verified public options are available
  in the release candidate, unless fewer satisfy the documented bar.
- Every visible entry has current operator/policy/registration metadata and a
  review date. No raw third-party directory is fetched by the client.

### Z4 - Harden the Mac mini as optional community infrastructure

**Implementation**

- Reframe `infra/homeserver` as a community-hosted reference deployment with no
  promised SLA, not Mesh's mandatory production backend.
- Keep public registration closed by default. Allow account creation only
  through explicit owner-controlled admission tokens or an operator-selected
  registration flow.
- Prove stable Matrix identity, backed-up signing keys, TLS, federation, router
  restart recovery, dynamic-DNS recovery, service auto-start, clock health, and
  adequate disk headroom.
- Configure explicit login, registration, messaging, media, and federation
  rate limits; per-user/media quotas; retention rules; abuse contacts; and
  emergency registration shutdown.
- Automate encrypted backups to storage independent of the Mac mini's primary
  disk. Include database, media, signing keys, secrets/config inventory, and a
  quarterly restore drill with dated evidence. Zero-cost may use owner-provided
  existing storage; it must still be failure-independent.
- Publish a lightweight status/maintenance page using a free static host and
  bounded health checks. Do not collect content or credentials for monitoring.
- Document federation troubleshooting and a migration procedure for moving the
  service while preserving its server name, signing keys, database, and media.

**Exit criteria**

- The Mac mini can lose its application disk and be restored from the documented
  backup without losing server identity.
- Public-service accounts can federate into and out of its test community.
- Users are clearly told that it is community-operated and has no uptime SLA.

### Z5 - Build a zero-cost public distribution and update path

**Implementation**

- Use public-repository GitHub Actions and GitHub Releases/Pages for CI,
  artifacts, checksums, SBOM/provenance, a canonical download page, the HTTPS
  invite fallback, and signed updater metadata where their current free terms
  permit it.
- Generate and protect the Tauri updater signing key independently of
  Authenticode. Publish signed beta/stable channel manifests with rollback; use
  explicit channels rather than server-side percentage rollout.
- Apply to SignPath Foundation or another legitimate free open-source signing
  program for Windows Authenticode. If Mesh does not qualify or is not accepted,
  label unsigned packages as developer previews and keep "consumer production
  beta" blocked; never bypass SmartScreen or signing controls.
- Verify artifact hashes, SBOM, provenance, latest-download redirects, updater
  signature failure, rollback, offline behavior, and clean Windows install/
  uninstall/upgrade behavior.
- Publish Terms, Privacy, Security, support/abuse contacts, third-party service
  disclosure, and data export/deactivation guidance before external beta.

**Exit criteria**

- A stranger can obtain the canonical release without a paid Mesh service,
  validate it, install it, open an invitation, and receive a signed update.
- The public artifact and latest-download route are tested from outside the
  development machine.

### Z6 - Complete multi-service identity, session, and recovery

**Implementation**

- Support the login/registration capabilities advertised by each selected
  service rather than assuming password registration.
- Complete browser OIDC/SSO callback, encrypted session persistence, restart,
  refresh, revocation, logout, second device, cross-signing, key backup,
  recovery, data export, and account deactivation testing.
- Make provider-specific limitations explicit. Do not promise that Mesh can
  delete server-retained data beyond the selected service's supported Matrix
  APIs and policy.
- Preserve the existing verified fresh-store decryption and additive
  `m.direct` reconciliation behavior.

**Exit criteria**

- Identity and encrypted-history recovery pass for password, browser/SSO, and
  saved-session paths on every catalog login class.
- Account removal clears local credentials and state even when remote
  deactivation is unavailable or requires provider-side action.

### Z7 - Make voice a detected capability, not a hosting promise

**Implementation**

- Keep MatrixRTC hidden or unavailable unless the selected account/room
  environment advertises a compatible, trusted RTC focus.
- Treat voice availability as a room/service capability. Public-service text
  chat must work even when that service offers no compatible voice backend.
- For communities that opt into the Mac mini RTC stack, validate LiveKit
  authorization, TURN/TLS, membership-bound media E2EE and key rotation,
  reconnect, federation, revoked devices, multi-party calls, physical devices,
  and two-network traversal.
- Provide a plain explanation when voice is unavailable and retain diagnostics
  for advanced users.

**Exit criteria**

- Mesh never routes a call through an untrusted or unadvertised focus.
- Text/community membership remains fully usable without voice.

### Z8 - Finish P1 hardening and wider-beta evidence

**Implementation**

- Replace symbolic security-invariant name checks with behavior-level
  command-boundary tests.
- Budget all production chunks plus startup, memory, CPU, sync, and scrolling
  behavior. Benchmark and virtualize large member/room/DM lists without
  breaking keyboard focus or screen-reader order.
- Finish moderation/reporting, public-service abuse routing, role/permission
  acceptance, accessibility across the complete onboarding/chat/call path, and
  operator incident/restore exercises.
- Run a bounded invited beta, record service-specific failure rates and support
  issues without collecting message content, and close every P0/P1 regression.

**Exit criteria**

- All release, security, accessibility, multi-service onboarding, federation,
  recovery, and clean-machine acceptance gates pass on one release SHA.
- Remaining limitations are documented as non-blocking and do not contradict
  the consumer onboarding promise.

## Required verification commands for every implementation tranche

Run only the commands relevant to changed code during development, then run the
complete release gate before declaring a release candidate. On Windows, stop
`meshcord.exe` if it locks Rust artifacts, serialize Rust (`--jobs 1` or
`CARGO_BUILD_JOBS=1`), and keep Vitest/Playwright workers bounded.

```powershell
cd D:\Creations\Applications\mesh\mesh
npm ci
npx tsc --noEmit
npm run lint
npm run check:ipc-contract
npm run check:ipc-types
npm run check:security-invariants
npm run check:design-tokens
npm run check:icons
npm run test -- --maxWorkers=4
npm run build
npm run check:bundle-size
npm run e2e -- --workers=1
npm audit --audit-level=high

# Add this in Z3 and keep it in release CI.
npm run check:public-services

python -m unittest discover -s infra/homeserver/tests -p "test_admission_service.py" -v

$env:CARGO_BUILD_JOBS='1'
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --no-default-features --features matrix-backend --all-targets --locked --jobs 1 -- -D warnings
npm run test:rust:matrix
npm run test:rust:legacy

npm run setup:matrix-spike:reset
npm run test:matrix-spike
```

Also run the documented legacy feature-tree tests until that tree is removed,
and run the disposable two-homeserver federation/recovery suite twice from
independent resets. Public-provider checks supplement these deterministic
gates; they do not replace them.

## Stop conditions and agent reporting contract

Stop and request owner action rather than guessing when a task requires:

- committing, pushing, publishing, deploying, changing DNS/router state, or
  mutating the Mac mini;
- accepting a public service's terms, creating test accounts, or solving
  CAPTCHA/interactive registration;
- selecting public-service candidates whose operator, policies, or current
  registration status cannot be verified directly;
- creating or storing release, updater, code-signing, admission, or service
  secrets;
- calling an unsigned installer, unverified public provider, OIDC flow, or
  MatrixRTC path production-ready.

After each tranche, report:

1. files changed and user-visible behavior;
2. tests and commands run with exact results;
3. which evidence was mocked, disposable-live, Mac-mini-live, or
   public-provider-live;
4. security/privacy decisions and known limitations;
5. owner-only actions or external approvals still required;
6. the next incomplete phase and its first executable step.

### Production gates that remain blocked under this decision

- Release-time re-review of every public-service catalog entry and low-volume
  login/registration acceptance using owner-controlled accounts.
- Clean-machine invitation install/resume through a publicly available signed
  installer and HTTPS fallback.
- Mac mini federation, backup/restore, rate-limit, abuse, and no-SLA acceptance.
- Production identity/session lifecycle across supported provider login classes.
- Capability-gated MatrixRTC live acceptance where voice is offered.
- Owner legal approval and publication of the privacy/terms/support/security
  pages through GitHub Pages.
- Qualification and enrollment in a free OSS signing program, Authenticode
  signing, public installer/SBOM/provenance publication, canonical download
  validation, and a signed updater/rollback path.
- Operator incident/restore exercises and a bounded invited beta with
  content-free reliability/support metrics.

---

## 0. How to use this document

This plan is organized into five workstreams (Backend/Rust, Frontend, Infrastructure & Release Engineering, Product/UX, and Cross-cutting Process). Each workstream has a **P0 / P1 / P2** backlog:

- **P0** — blocks calling this a "production beta" at all (breaks stated product promises, creates real user/data risk, or makes shipping fixes impossible).
- **P1** — needed before inviting a wider beta audience beyond the founding team.
- **P2** — hygiene, scale, and polish; do after P0/P1 land.

Every item below cites concrete files so an agent can navigate straight to the relevant code. Treat file:line references as pointers verified during this review (2026-07-29) — re-check them before editing, since the codebase moves fast.

**Suggested execution order across workstreams:** Infra P0 (1–5) and Product P0 (invite link + deep link) should start immediately and in parallel — they are the two biggest gaps between "it works for us" and "it works for a stranger." Backend and Frontend P0 items are lower-risk to defer by a sprint but should not slip past the first external beta invite.

---

## 1. Executive summary

Mesh is a Tauri (Rust) + React 19 desktop chat/voice app built on the Matrix protocol, positioned as a Discord-like consumer app that hides Matrix/homeserver complexity (see `AGENTS.md`). The codebase is ~87,000 LOC (43.5K TS/TSX, 43.6K Rust) with real CI, real E2E encryption via `matrix-sdk-crypto`, a disciplined feature-flag boundary separating the Matrix backend from a legacy P2P backend being retired, and genuinely functional messaging (reactions, replies, pins, custom emoji, real search, real OS notifications). This is further along than "very early prototype" suggests in places.

But three structural gaps make it not yet a production beta, regardless of feature depth:

1. **The onboarding promise in `AGENTS.md` is not actually implemented for the Matrix backend.** There is no shareable invite link and no OS deep-link handling — a new user cannot go from "received a link" to "in the community" without someone already inside the app walking them through a per-username invite. This is the single most important gap, because it's the product's own stated non-negotiable UX rule.
2. **The "managed homeserver" is a home Mac mini on residential internet with dynamic DNS**, not hosted infrastructure. There's no redundancy, no automated offsite backup, no monitoring/alerting, and updates are explicitly disabled pending an update-signing endpoint that doesn't exist yet. Shipping this to real external users today means shipping an app that cannot be patched and depends on one machine's uptime and one home ISP connection.
3. **No legal/trust baseline** — no Terms of Service, no Privacy Policy, no account-deletion or data-export flow, no rate limiting configured on the homeserver. Any of these is a blocker for onboarding users outside the founding team.

Everything else in this document (frontend test gaps, backend hardening, product parity features) matters for quality and should be worked in parallel, but the three items above are the actual gate between "works for us" and "safe to hand to a stranger."

---

## 2. Workstream A — Product & UX (close the North Star gap)

*Source: product/UX subagent review of `AGENTS.md`, onboarding flow, invite/community code, moderation, notifications, search.*

### A-P0 (blocks beta; breaks the app's own stated promise)

1. **Build a real Matrix invite-link flow.** Today `src/components/community/InviteModal.tsx` only offers a per-username server invite (`bridge.inviteMatrixUser`); the actual "generate a link, copy, share" flow (`generateInviteLink`) is wired only to the legacy P2P backend in `LegacyMigrationPanel.tsx` / `src-tauri/src/commands/community.rs` (`generate_invite_link` is legacy-only). A brand-new user with no Matrix account cannot be invited by username because they don't have an account yet.
   - Design a link format that carries (or resolves via the managed homeserver) everything needed: server, community/room ID, and — ideally — a one-time registration token so "open link → create account → land in community" is one motion, per `AGENTS.md`'s "Invitation links must carry or resolve everything needed to reach the service and community."
   - Add the Matrix-side backend command (mirroring the retired `generate_invite_link` but backed by Matrix room invites / `matrix.to` links or a custom `mesh://` scheme with server-side resolution).
   - Update `InviteModal.tsx` to generate and display this link as the primary invite mechanism; keep per-username invite as a secondary option for existing users.

2. **Register an OS URL scheme / deep-link plugin.** No `tauri-plugin-deep-link` dependency exists and `src-tauri/tauri.conf.json` has no URL scheme registered. Clicking an invite link outside the app currently does nothing — this breaks step 2 of the North Star's 4-step promise ("open an invitation").
   - Add `tauri-plugin-deep-link`, register a scheme (e.g. `mesh://`), and route incoming links into the join flow (`OnboardingFlow.tsx` / `JoinScreen.tsx`) whether the app is cold-started or already running.
   - Add an E2E test that simulates a deep-link launch and asserts it lands on the correct join screen pre-filled.

3. **Add account deletion and personal data export.** No such flow exists anywhere in `src` or `src-tauri` today (the existing "backup code" flow is encryption-key backup, not a data export). This is a trust and likely legal blocker for any non-team user.
   - Minimum viable: a settings action that (a) exports the user's own message history/media they have local copies of, and (b) requests account deactivation from the homeserver per the Matrix spec's deactivate-account API, with clear in-app copy on what is/isn't recoverable.

4. **Add non-Windows desktop build targets if any non-Windows beta users are expected.** `src-tauri/tauri.conf.json` currently targets `["msi","nsis"]` only; there is no macOS/Linux signing pipeline. Decide beta platform scope explicitly (see Infra B-P1 below) rather than defaulting to Windows-only by omission.

### A-P1 (baseline consumer-chat parity, needed before wider beta)

5. **Message threads.** Only flat single-level reply-to exists (`reply_to_id` in `commands/messaging.rs`); no thread view. Baseline Discord/Slack-alike expectation.
6. **Visible read receipts.** `sendReadReceipts` currently defaults off and is wired to Matrix's *private* read receipt (`UserSettingsPanel.tsx`, `backend/matrix.rs`), which is never visible to others. Add an opt-in "seen by" indicator using standard (non-private) receipts.
7. **Expand role/permission granularity.** Moderation today only supports Owner/Admin/Member (`backend/matrix/moderation.rs`); add custom roles and per-channel permission overrides in `CommunitySettings.tsx` / `commands/permissions.rs`.
8. **User profile depth.** Currently just display name + color avatar; add avatar images, bio/status message.
9. **Reporting/flagging pipeline.** Moderation covers ban/kick/role changes with an audit trail, but there's no user-facing "report this message" path feeding moderators a queue.

### A-P2 (polish / scale, after P0/P1)

10. Cross-community/global search (current search is scoped per-community).
11. Mobile app feasibility spike (even read-only companion), consistent with the North Star's migration-readiness intent.
12. Pixel/interaction audit of the voice UI against `design_handoff_mesh_chat_voice/mesh-shell.html` — a dedicated focused pass, since this review didn't fully verify implementation-vs-mock fidelity.
13. Explicitly sunset or clearly gate the legacy P2P invite path so the codebase doesn't carry two incompatible onboarding stories once the Matrix invite-link flow (A-P0.1) ships.

---

## 3. Workstream B — Infrastructure, Release Engineering & Operations

*Source: infra subagent review of CI/CD, `infra/homeserver`, `infra/matrixrtc`, release scripts, `tauri.conf.json`, licensing.*

This is the workstream with the largest gap between "looks production-grade" (SHA-pinned GitHub Actions, SBOMs, cargo-audit, trufflehog secret scanning, a real preflight script, Authenticode-signed installers) and "is production-grade" (a home Mac mini as the entire backend).

### B-P0 (blocking any real production beta)

1. **Move the homeserver off the home Mac mini.** `mesh/infra/homeserver/README.md` describes a Synapse stack run via LaunchAgent + Docker on a Mac mini behind a home router with Cloudflare DDNS polling every 5 minutes. This is a single point of failure with no SLA, tied to residential ISP uptime. Migrate to real hosted infrastructure (managed Postgres, redundant compute, static IP/proper DNS) — this is the highest-leverage infra task in the whole plan.
2. **Automate offsite backups and prove restore works.** `backup.sh` currently writes `pg_dump` + signing key + media tarballs to local disk only; the README explicitly tells operators to manually copy backups to a separate disk. Replace with automated offsite/cloud backup plus a scheduled, tested restore drill (not just "backup exists").
3. **Build the signed-update endpoint and updater public key.** `scripts/beta-release-preflight.ps1`'s `Assert-NoUpdaterConfiguration` currently *forbids* any updater config, and release notes state updates are disabled "until Mesh has a provisioned signed-update endpoint and updater public key." Until this exists, every security fix requires each user to manually reinstall — untenable for a real beta. Stand up the endpoint, generate/store the signing key securely, wire Tauri's updater plugin, then flip the preflight assertion.
4. **Configure and load-test Synapse rate limiting.** `configure_synapse.py` sets registration/media/federation options but never touches `rc_message` / `rc_registration` / `rc_login` / `rc_federation` blocks — currently relying on unverified Synapse defaults on home internet. Configure explicitly and load-test before opening registration beyond the team.
5. **Add crash reporting and health monitoring.** No Sentry or equivalent telemetry exists in `src` or `src-tauri` (confirmed via full-tree grep), and no monitoring/alerting service backs the homeserver or MatrixRTC stack despite `infra/operator-smoke/.env.example` already referencing `MESH_SMOKE_BACKUP_STATUS_URL` / `MESH_SMOKE_MONITORING_HEALTH_URL` as if they existed. Add opt-in crash/error telemetry client-side and real uptime/health monitoring + alerting server-side.
6. **Publish Terms of Service and a Privacy Policy, and define the data-deletion/GDPR flow** before onboarding any user outside the team (pairs with Product A-P0.3).

### B-P1 (needed before wider beta)

7. **Stand up macOS (and ideally Linux) signed build/notarization**, once platform scope is decided (pairs with Product A-P0.4) — currently Windows-only end to end.
8. **Replace the name-existence security-invariant check with a real behavioral test.** `scripts/check-security-invariants.mjs` only regexes for function *names* (`ensure_room_is_encrypted`, `validate_attachment_payload`, etc.) existing anywhere in the Rust tree — it cannot catch a call site being removed or bypassed. Upgrade to an AST/call-graph check or targeted integration tests asserting the invariant actually holds on every code path that should enforce it.
9. **Validate MatrixRTC (voice) at real capacity.** `infra/matrixrtc`'s LiveKit stack is deliberately gated off (`MESH_RTC_ENABLED=0`) pending DNS/TLS/authorization/TURN validation, and is scoped to one host's port range (~100 concurrent RTP streams). Define and test a real capacity/scaling plan before voice ships broadly.
10. **Wire the nightly TURN probe** (`nightly-soak.yml`, currently soft-disabled pending `MESH_NIGHTLY_TURN_ENABLED`) once real TURN infra exists.

### B-P2 (hygiene / before scaling further)

11. Add `SECURITY.md` and a coordinated vulnerability disclosure process.
12. Periodically re-triage the 7 RUSTSEC advisories currently ignored in `security.yml`/`release-beta.yml` (justified today as confined to the excluded `legacy-p2p` dependency graph — re-verify that boundary holds as the codebase evolves).
13. Decide an AGPL-3.0 commercial strategy (CLA / dual-license) **before** accepting external contributions to a codebase backing a hosted service — network use of AGPL code counts as distribution, which has real implications for operating "Mesh" as a managed service.

---

## 4. Workstream C — Backend (Rust / Tauri)

*Source: backend subagent review of `src-tauri/src` — crypto, storage, network, commands, state.*

The Matrix-backend/legacy-p2p split is real and compiler-enforced (`compile_error!` in `lib.rs` plus `#[cfg(feature = "legacy-p2p")]` gating on `network`, `storage`, `migration`, `app_runtime` modules), and `#![deny(clippy::unwrap_used)]` is enforced in crypto/state modules — genuine engineering discipline, not just CI theater. Gaps are narrower here than in infra, but still real.

### C-P0

1. **Harden the security-invariant CI check** (same item as B-P1.8 — listed here too since it's a backend-authored control). Move from symbol-existence regex (`scripts/check-security-invariants.mjs`) to verifying call-site coverage, e.g. that every room-mutating command actually invokes `require_protected_room` / `ensure_room_is_encrypted`.
2. **Add key eviction/TTL to the in-memory rate limiter.** `src-tauri/src/state/rate_limits.rs`'s `RateLimitState.entries: Mutex<HashMap<String, VecDeque<Instant>>>` never removes keys once created — long-running instances accumulate empty-but-present entries indefinitely. Add a sweep/TTL so memory is bounded on long-lived sessions.

### C-P1

3. **Audit all Tauri IPC commands for per-command authorization.** `commands/backend.rs` alone exposes 93 `#[tauri::command]` entry points — the highest-risk attack surface from the frontend. Confirm each has appropriate session-ownership/authorization checks and that `scripts/check-tauri-ipc-contract.mjs` actually covers all of them, not just a subset.
4. **Resolve the fate of the custom legacy crypto scheme.** `src-tauri/src/crypto/encryption.rs` implements a hand-rolled X25519+HKDF+ChaCha20-Poly1305 key-wrap with no forward secrecy (its own comment says it's a placeholder pending "Double Ratchet session management"). It's confined to `legacy-p2p` today and does not affect the Matrix production path, but should be explicitly deleted or clearly marked dead-end so no future contributor extends it under the impression it's production crypto.
5. **Expand live/integration testing of Matrix federation paths.** `tests/matrix_federation_live_tests.rs` exists but is feature-gated behind `--ignored` and requires live infra, so it's likely skipped in normal CI — the manual E2E run only exercised single-server basics, not federation.

### C-P2

6. **Add streaming/chunked upload** for attachments if large-file transfer becomes a target use case (current cap is a flat 100MB with decode-bomb guards in `backend/matrix/attachments.rs`, but no chunking).
7. **Revisit unbounded in-memory pagination**: `backend/matrix/messages.rs` bounds pagination at `MAX_EVENTS=10_000` per call, but a single call can still hold 10,000 deserialized events in memory — fine for prototype-scale history, worth revisiting for long-lived, high-traffic rooms.
8. **Add fallback detection for the Linux keyring-daemon-absent case** in `crypto/keychain.rs` (currently logs a warning only; verify there's no silent plaintext-fallback path).

---

## 5. Workstream D — Frontend (React / TypeScript)

*Source: frontend subagent review of `src/`, `e2e/`, state stores, IPC bridge, voice integration.*

Similar pattern to backend: real engineering care exists (a structured `AppError` type with actionable messaging, scoped error boundaries, retry/backoff in the IPC bridge, a mature LiveKit voice layer with reconnect handling) alongside genuinely unfinished/untested load-bearing paths.

### D-P0

1. **Resolve the orphaned invite-codec module.** `src/lib/invite-codec.ts`'s `parseInviteLink`/`generateInviteLink` are exported but never imported anywhere in `src/` — the real join flow calls `bridge.joinCommunity()` directly. This ties directly into Product A-P0.1/A-P0.2: decide whether this module becomes the real invite-link implementation or gets deleted, and add community-invite-specific error codes to `src/lib/errors.ts` so invite failures aren't a generic "unknown" message.
2. **Fix cross-store cleanup on channel deletion.** `store/channels.ts`'s `removeChannel` deletes the channel entity, but `store/messages.ts`'s per-channel message cache is never purged when `useCommunitySync.ts` handles a `channel_delete` event — orphaned messages persist in memory and could resurface if a channel ID is reused.
3. **Add E2E coverage for the actual production voice path.** `e2e/voice-session.spec.ts` tests the legacy P2P voice engine (`voice-engine.ts`), not `livekit-voice.ts`, which is what `useVoiceEngine.ts` actually uses today. Reconnect/epoch-guarded publication logic in `livekit-voice.ts` is unit-tested but never exercised end-to-end.
4. **Add a permission-denied error branch.** No `NotAllowedError` handling exists in `livekit-voice.ts`, `voice-engine.ts`, or `errors.ts`'s `inferCode` — a real mic/camera permission denial currently surfaces as a generic error instead of "allow microphone access in system settings," violating `AGENTS.md`'s "errors must explain what the user can do next" rule.
5. **Backfill unit tests for `src/store/*`.** Every store file (`channels.ts`, `communities.ts`, `dms.ts`, `identity.ts`, `membership.ts`, `network.ts`, `typing.ts`, `custom-emoji.ts`) has zero test coverage today — this is the layer most responsible for state consistency across the app. Start with `network.ts` and `membership.ts` given their sync-critical role.

### D-P1

6. Extend `bridge.resilience.test.ts` to cover exhausted-retry and offline/reconnect scenarios (current 6 cases only cover in-flight coalescing, single retry, and timeout — not real disconnect simulation); fix silent failure swallows in `probeIceServers`, `getIceServers`, and `sendVoiceSignal` in `bridge.ts`, which currently degrade silently to `console.warn`/`console.error`.
7. Extend accessibility E2E beyond the single `MatrixAccountScreen` currently covered in `onboarding-accessibility.spec.ts` to all five onboarding screens (`IdentityScreen`, `JoinScreen`, `BackupCodeScreen`, `ReadyScreen`), and add axe checks to the chat/DM/voice E2E specs, which currently run zero accessibility assertions.
8. Wire `check:bundle-size` and `check:ipc-contract` scripts into CI explicitly if they aren't already part of every workflow run — confirm this is covered by the `ci.yml` job discovered during the infra review, since this frontend-focused pass did not have visibility into the workflow files.
9. Add list virtualization to `MemberList.tsx`, `ChannelSidebar.tsx`, and `DmSidebar.tsx` — currently `useVirtualScroll` is only applied in `ChatView.tsx`, leaving other large-list surfaces unvirtualized.
10. Surface permanent-failure state to the UI from `scheduler.ts`'s indefinite backoff and `useQueuedMessageSync.ts`'s post-restart rehydration failure — both currently fail silently to `console.error` with no user-facing state or retry affordance.

### D-P2

11. Introduce an i18n framework before English string volume grows further (none exists today — confirmed no react-i18next/formatjs or equivalent in `package.json`).
12. Add scoped error boundaries inside `components/voice/` and `components/community/` directly, rather than relying solely on the single boundary in `ContentArea.tsx`, so a crash in `VoicePeerGrid` or `CommunitySettings` degrades locally instead of taking down the whole content pane.
13. Backfill component tests for `VoicePeerGrid.tsx`, `VoiceView.tsx`, `CommunitySettings.tsx`, and the layout components (`AppLayout.tsx`, `ChannelSidebar.tsx`, `ContentArea.tsx`, `DmSidebar.tsx`).

---

## 6. Workstream E — Cross-cutting process recommendations

1. **Track this plan as issues, not a static doc.** Convert each numbered item above into a tracked issue (GitHub Issues, Linear, etc.) tagged by workstream and priority, so progress is visible and items don't silently rot.
2. **Gate the first non-team beta invite on Infra B-P0 (all 6 items) and Product A-P0 (all 4 items) being done.** Everything else can ship incrementally after that gate, but those ten items are the actual definition of "safe to invite a stranger."
3. **Re-run this review periodically.** Several findings here (e.g., the RUSTSEC-ignore list, the legacy-p2p/matrix-backend boundary, the security-invariant check) are the kind of thing that silently regresses as the codebase evolves. Treat re-verification of "is libp2p really excluded from the matrix-backend production tree" and similar boundary assertions as a recurring, not one-time, task.
4. **Keep the honest self-disclosure pattern already present in the repo.** `matrix-federation-acceptance.yml` already contains a comment stating its results are "not evidence that the managed production service is ready" — that kind of explicit scoping is valuable and should be extended to other places where CI-passing could be mistaken for production-readiness (e.g., the security-invariant check, the nightly soak job).

---

## Appendix: Source review scope

This plan synthesizes four parallel deep-dive reviews conducted 2026-07-29 against the repository at `D:\Creations\Applications\mesh` (git branch `main`, HEAD `2ca3dcc`):

- **Backend/Rust**: `mesh/src-tauri/src/**` (crypto, storage, network, backend/matrix, commands, state), `mesh/scripts/check-security-invariants.mjs`, `mesh/scripts/check-tauri-ipc-contract.mjs`.
- **Frontend**: `mesh/src/**` (stores, hooks, lib, components), `mesh/e2e/**`, `mesh/src/types/ipc*.ts`.
- **Infrastructure/Release**: `.github/workflows/*.yml`, `mesh/infra/**`, `mesh/scripts/*.ps1`/`*.sh`, `mesh/src-tauri/tauri.conf.json`, `mesh/src-tauri/capabilities/`, `LICENSE`, `COPYRIGHT`.
- **Product/UX**: `AGENTS.md`, `design_handoff_mesh_chat_voice/`, onboarding and community components, moderation/notification/search code paths.

Repo scale at time of review: ~43,558 LOC TypeScript/TSX, ~43,591 LOC Rust, 272 Rust `#[test]` functions across 24 test modules.
