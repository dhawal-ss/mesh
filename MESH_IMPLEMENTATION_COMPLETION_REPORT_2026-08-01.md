# Mesh implementation completion report — 2026-08-01

## Release verdict

`ALL_LOCALLY_SPECIFIABLE_FINDINGS_COMPLETE_NOT_RELEASE_READY`

The Phase 1–4 repository work is implemented and locally verified. Mesh is not
a release candidate: the source tree is dirty, the current evidence is not from
protected same-SHA CI, and the signing, installed-device, provider, operator,
manual accessibility, public-release, and physical MatrixRTC campaigns have not
been completed. Local mocks and disposable services are not counted as those
external results.

## Finding disposition

| ID | Severity | Root cause | Implemented fix | Primary files | Regression evidence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| S1 Registration capability discovery | P0 | Discovery submitted an empty registration request that a permissive service could treat as account creation. | Replaced the speculative request with non-mutating capability/configuration discovery; ambiguous, unsupported, closed, token-only, authenticated-registration, SSO-only, and malformed responses fail closed. | `mesh/src-tauri/src/backend/matrix.rs`, `mesh/src-tauri/src/backend/matrix/tests/mod.rs` | `registration_capability_discovery_never_submits_registration_data`, `registration_capability_probe_is_non_mutating_across_server_policies` | Complete locally |
| S2 Admission identity boundary | P0 | A reusable Matrix client access token crossed into a separately configured admission service. | Uses a short-lived Matrix OpenID credential in the HTTPS POST body, bound to purpose, subject, audience, service, and user; replay identity is derived from the underlying credential. The admission verifier and token issuer remain unconfigured and fail closed in production because the standard verifier would place the credential in a query URL. | `mesh/src-tauri/src/backend/matrix.rs`, `mesh/infra/homeserver/admission_service.py`, `mesh/infra/homeserver/bootstrap_admission_service.py`, `mesh/docs/security/PHASE1_NATIVE_SECURITY_BOUNDARIES.md` | Admission tests cover replay, changed envelope UUID/purpose/subject/audience, wrong user/service, malformed/expired proofs, secret redaction, and rejection of client `Authorization` headers. | Safe scaffolding complete; production verifier and least-privilege issuer are owner-blocked |
| S3 Opaque pending invitations | P0 | Renderer IPC could retrieve the raw saved invitation and its bearer-like admission token, including when an attacker duplicated that capability into a presentation field. | Native code owns invitation secrets and exposes only an opaque expiring handle plus shape-validated, bounded presentation metadata. Metadata fields containing the capability are suppressed. Join and clear operations require the matching handle, serialize against account transitions, and prevent replay. Windows cold-start persistence completes before renderer startup. | `mesh/src-tauri/src/commands/pending_invitation.rs`, `mesh/src-tauri/src/backend/matrix.rs`, `mesh/src-tauri/src/backend/mod.rs`, `mesh/src-tauri/src/lib.rs`, `mesh/src/lib/bridge.ts`, `mesh/src/App.tsx` | Rust pending-invitation metadata/leak boundary tests, `src/App.invitation.test.tsx`, bridge invitation tests, and installed-shell invitation E2E | Complete locally on Windows; macOS/Linux installed delivery remains external R4 |
| S4 Invitation SSRF and mode downgrade | P0 | Invitation-controlled origins could be contacted before informed confirmation, could resolve or redirect into unsafe networks, and a malformed admission-form link could fall back to a direct room join. | Defers contact until confirmation; requires production HTTPS; validates every resolved address; rejects loopback, private, link-local, multicast, unspecified, mapped IPv4, documentation, transition, and other non-forwardable IPv6 ranges; disables redirects and applies bounded connect/read/total timeouts. Admission and direct-v5 links now have separate strict parsers, so incomplete admission links fail closed instead of downgrading. Development loopback remains isolated. | `mesh/src-tauri/src/backend/matrix/admission.rs`, `mesh/src-tauri/src/backend/matrix.rs`, `mesh/src-tauri/src/backend/matrix/tests/mod.rs`, `mesh/src/App.tsx` | IPv4/IPv6/special-use/mapped-address, origin, redirect, rebinding, localhost, secret-error, delayed-confirmation, and admission-to-direct downgrade tests | Complete locally |
| S5 Active attachments | P0 | Filename or declared MIME alone could allow executable or active content to reach preview/open paths. | Central classifier combines normalized filename, extension, MIME, signatures, and bounded text sniffing. Upload, download, preview, save, and open paths reject active or ambiguous content; OS open reclassifies the final file. Received encrypted thumbnails stay outside plaintext renderer loading. | `mesh/src-tauri/src/security.rs`, `mesh/src-tauri/src/backend/matrix/attachments.rs`, `mesh/src-tauri/src/commands/attachments.rs`, `mesh/src/components/chat/EncryptedAttachmentPreview.tsx` | Rust classifier/grant/open tests and encrypted-thumbnail renderer tests | Complete locally |
| S6 Moderation audit authority | P0 | Ordinary member-readable room notices were forgeable and could not prove historical authority or private operator access. | Removed authoritative claims for member events, classifies forged/former/demoted/cross-community/malformed records as untrusted, and fails authoritative retrieval closed until an access-restricted append-only contract exists. | `mesh/src-tauri/src/backend/matrix/moderation.rs`, `mesh/src-tauri/src/backend/matrix/tests/mod.rs`, security documentation | Moderation forgery, demotion, creator/last-owner, cross-community, malformed-event, unauthorized-reader, and failure-copy tests | Safe behavior complete; authoritative audit contract is owner-blocked |
| S7 Native resource limits | P1 | Per-transfer caps did not bound aggregate memory/concurrency, full-image reads could allocate outside the scheduler, and an invitation service response could be buffered without enforcing its 64 KiB limit while streaming. | Adds shared upload/download slot and byte budgets, reserves before allocation, rejects invalid/oversized reservations, supports cancellation cleanup, bounds protected lightbox reads, enforces the renderer text limit for native send/edit/caption boundaries, and accumulates admission responses chunk-by-chunk with a checked hard cap. | `mesh/src-tauri/src/backend/matrix.rs`, `mesh/src-tauri/src/backend/matrix/attachments.rs`, `mesh/src-tauri/src/backend/matrix/admission.rs`, `mesh/src-tauri/src/commands/attachments.rs` | Concurrent budget, cancellation, cache, oversized stream/edit/caption, exhaustion, recovery, lightbox scheduler, and admission-response streaming-limit tests | Complete locally within the bounded in-memory product limit; larger attachment streaming is a product decision |
| O1 Account-service choice | P1 | A dirty implementation exposed an unconditional hard-coded Mesh account service and risked coupling account hosting to community hosting. | Removed the unconditional managed-service choice. Matrix.org remains prominent and independently described; reviewed public services, invitation-offered community service, and “Use another service” are explicit paths with no automatic selection. | `mesh/src/components/onboarding/MatrixAccountScreen.tsx`, `mesh/src/config/public-services.ts`, `mesh/src/config/public-services.json`, onboarding tests | No-invitation, community-offer, Matrix.org, reviewed-public, custom, unavailable, cross-service federation, no-auto-select, and stale-status tests | Complete locally |
| O2 Service-scoped async account state | P1 | Username, capability, or browser/OIDC readiness responses could outlive a service switch and authorize submission using stale evidence. | Normalizes service identity, keys username state by service plus username, invalidates on either change, and uses independent generation guards for availability, capability, and browser/OIDC readiness responses. Native admission values remain issuer/user/purpose/expiry bound. | `mesh/src/components/onboarding/MatrixAccountScreen.tsx`, `mesh/src/components/onboarding/accountCreation.ts`, `mesh/src-tauri/src/backend/matrix.rs` | Account-screen generation/service-switch/OIDC-readiness tests plus admission replay/cross-service tests | Complete locally |
| R1 Load failures versus empty state | P1 | DM and timeline fetch failures could be rendered as a legitimate empty conversation, while a late mark-read or room-upgrade failure could appear after the user switched rooms. | Adds explicit idle/loading/loaded/stale/failed state, preserves last-good data, exposes retry, generation-guards live refreshes, marks read only after successful history hydration, and scopes mark-read and room-upgrade failures to the room that produced them. | `mesh/src/store/dms.ts`, `mesh/src/components/chat/DmView.tsx`, `mesh/src/components/layout/DmSidebar.tsx`, `mesh/src/components/chat/ChatView.tsx` | DM/timeline offline, malformed, timeout, failure, stale-refresh, recovery, retry, late mark-read, and room-switch upgrade-error tests | Complete locally |
| R2 Per-community room refresh | P1 | One rejected community request discarded successful room results and could leave a room from the previous community interactive while the newly selected community refreshed. | Prioritizes the selected community, settles communities independently, preserves last-good rooms, records per-community refresh status/generation, and repairs the active channel synchronously from local state before awaiting network refresh. | `mesh/src/App.tsx`, `mesh/src/App.invitation.test.tsx`, `mesh/src/store/channels.ts` | Channel resilience, immediate cross-community repair, and authenticated-shell navigation coverage | Complete locally |
| R3 Recoverable community creation | P1 | Community creation, starter-room creation, activation, and refresh were one opaque transaction, so partial success encouraged duplicate retries. | Models each phase, reports partial success, remembers created resources, and provides an idempotent finish-setup retry. | `mesh/src/components/community/CreateCommunityModal.tsx` | Failure injection and duplicate-prevention tests for each phase | Complete locally |
| R4 Message and moderation mutations | P1 | Per-call state did not prevent duplicate operations; stale completions and console-only errors could overwrite current rows or lose edits; pin failures were swallowed by the store after optimistic rollback and therefore offered no retry. | Adds component-scoped attempts, synchronous deduplication, pending/success/failed/retrying/superseded states, current-attempt-only completion, rollback, retry, disabled duplicate controls, edit preservation, and pin/unpin participation in the same visible mutation state. | `mesh/src/components/chat/Message.tsx`, `mesh/src/components/chat/Message.test.tsx`, `mesh/src/store/room-pins.ts` | Duplicate, stale-row, unmount, retry, rollback, edit, reaction, pin/unpin, timeout, kick, ban, and delete tests | Complete locally |
| R5 Encryption UI/native agreement | P0 | UI copy and composer state could disagree with the native protected-room guard. | Composer availability derives from current room protection; encrypted, unknown, unavailable, and recovering states explain the next action while native send boundaries remain fail closed. | `mesh/src/components/chat/ChatView.tsx`, `mesh/src/components/chat/DmView.tsx`, `mesh/src-tauri/src/backend/matrix.rs` | Renderer protection-state tests and native encrypted/protected-room boundary tests | Complete locally |
| R6 Browser storage resilience | P1 | Direct storage access and framework persistence could throw during startup, quota denial, corruption, or post-removal cleanup. | Central safe local/session storage helpers catch property access and operation failures; room tabs, layouts, registration continuation, settings persistence, account cleanup, and command-palette recents use the boundary. Native account removal success is not reversed by optional renderer cleanup failure. | `mesh/src/lib/safe-storage.ts`, `mesh/src/lib/account-transition.ts`, `mesh/src/lib/registration-continuation.ts`, `mesh/src/store/settings.ts`, `mesh/src/components/layout/AppLayout.tsx`, `mesh/src/components/navigation/CommandPalette.tsx`, `mesh/src/components/settings/SecurityDevicesPanel.tsx` | Safe-storage, settings-storage, registration-continuation, room restoration, account transition, and security-panel tests | Complete locally |
| R7 Accessibility and restoration | P1 | Controls and transitions lacked complete names/focus restoration, saved tabs could be overwritten before authoritative hydration, and the pixel-avatar rebuild placed `aria-label` on a roleless `div`, causing serious WCAG failures across eight browser surfaces. | Labels multiline/custom controls, prevents multiline Enter navigation, restores transition/dialog focus, waits for authoritative room/DM snapshots, surfaces room-upgrade/mark-read failures, gives named avatars a valid image role, and keeps keyboard/zoom/motion/contrast paths covered. | Renderer components and `mesh/e2e/*.spec.ts`; focused restoration in `mesh/src/components/layout/AppLayout.tsx`; avatar semantics in `mesh/src/components/ui/Avatar.tsx` | Avatar unit regression plus 67 Playwright cases including automated WCAG A/AA, keyboard, narrow layouts, 200% zoom, reduced motion, high contrast, and focus restoration | Automated/local complete; physical assistive-technology/WebView campaign remains external |
| C1 Windows federation timing | P1 | The deadline helper depended on receiving exactly three real-time polls inside 40 ms, and the protected disposable-federation workflow exercised only one reset/test cycle. | Converted the assertion to deterministic deadline/state-machine behavior with bounded retry-after handling and made CI run two independent reset/test cycles with separately hashed logs plus an exact-source report. | `mesh/src-tauri/tests/matrix_federation_live_tests.rs`, `.github/workflows/matrix-federation-acceptance.yml` | Deterministic helper repetitions plus two independent local live federation cycles; workflow contract requires the same two-cycle evidence | Complete locally; protected same-SHA workflow evidence still required |
| C2 Restore drill | P0 | Missing abuse email, UID 991 bind ownership, and cleanup error masking made nightly destructive restore nondeterministic. | Supplies deterministic abuse contact, normalizes Synapse ownership, preserves original exit status, makes cleanup idempotent, performs real backup/tamper rejection/destructive restore/integrity/application-boot checks, and runs two separately hashed iterations in nightly CI. | `mesh/infra/homeserver/tests/restore-drill.integration.sh`, homeserver scripts, `.github/workflows/nightly-soak.yml` | Shell/config tests and two-iteration workflow contract validation | Repository preparation complete; two protected Linux workflow artifacts remain external evidence |
| C3 Rust dependency policy | P1 | Raw lockfile findings and the shipping Matrix graph were conflated; historical counts drifted across workflow and documentation; seven shipping-runtime unmaintained warnings and one build-only warning were not enumerated as exact policy. | One policy file drives Matrix shipping audit/reporting, explicitly enumerates seven reviewed Matrix-runtime warnings, one non-runtime build warning, two legacy-only vulnerabilities, and exact raw warning counts. Matrix artifacts exclude legacy `libp2p`; any advisory-count drift fails, and raw findings remain visible rather than described as fixed. | `mesh/scripts/rust-dependency-policy.json`, `mesh/scripts/check-matrix-release-dependencies.ps1`, workflows, readiness ledger | Matrix release policy reports zero shipping vulnerabilities, 7 reviewed runtime warnings, 1 build-only warning, and 2 legacy-only Hickory vulnerabilities | Complete locally for shipping scope; upstream legacy debt remains open and clean exact-SHA R0 evidence is blocked |
| C4 Release workflow security | P0 | Tag ancestry, environment protection, validation-only dispatch, scanner pinning, evidence provenance, ownership, and dependency policy were incomplete; downloaded evidence dirtied the Windows checkout before its clean-source gate, checksums were omitted from attestation, and certificate material cleanup was not failure-safe. | Adds protected-main ancestry checks, protected release environment, tag-only draft candidate publication, validation-only generic dispatch, immutable scanners, CodeQL/SAST, dependency review, Dependabot, license policy, CODEOWNERS, SBOM/checksum/provenance outputs, and exact-SHA evidence validation. Quality reports stay in runner temp until clean-source validation, checked-out lock/policy hashes and counts are revalidated before import, `SHA256SUMS.txt` is attested, and the non-exportable PFX/certificate are cleaned in failure-safe steps. R2 now covers 50 Windows/service cases; eight macOS/Linux AT and native-invitation cases are explicit R4 gates. There is deliberately no public promotion path and the updater stays disabled. | `.github/workflows/*.yml`, `.github/CODEOWNERS`, `.github/dependabot.yml`, `.github/dependency-review-config.yml`, `LICENSE_POLICY.md`, `SECURITY.md`, `mesh/scripts/beta-release-preflight.ps1`, `mesh/release/readiness.json`, `mesh/scripts/check-external-acceptance.mjs` | YAML/Bash/PowerShell/preflight/security/dependency/readiness/external-acceptance contract tests | Repository preparation complete; protected credentials/runs and promotion contract remain external/owner-blocked |
| C5 Bundle budgets | P1 | LiveKit and total JavaScript were near their limits and could accidentally enter the eager path. | Preserves dynamic LiveKit loading, keeps SimplePeer outside the Matrix bundle, binds bundle reports to source SHA, and leaves budgets unchanged. | `mesh/scripts/check-bundle-size.mjs`, Vite mode boundaries, release workflow | Current Matrix build: 227.66 KiB entry, 447.02 KiB eager JS, 1,909.18 KiB all JS, 2,341.98 KiB all production assets | Complete locally |

## Security-boundary and threat-model result

- Account hosting, community routing, and optional admission remain separate.
  An account on Matrix.org or another compatible service can join a differently
  hosted community when federation and room policy allow it.
- The admission service receives neither the Matrix client session token nor a
  renderer-readable invitation secret. Production admission remains unavailable
  until a credential-safe verifier and least-privilege issuer are approved.
- Invitation metadata is untrusted presentation data. Native code retains the
  capability, validates its origin, and owns the claim/join transition.
- Attachment names, declared MIME values, and remote metadata are attacker
  controlled. Native classification and resource reservation precede preview or
  operating-system open.
- Member room events are not an authoritative moderation ledger. The product
  fails closed instead of presenting them as private or historically verified.
- MatrixRTC configuration and local validators do not enable voice. Media stays
  unavailable until the signed-build 23-case physical campaign passes.
- The Matrix production artifact excludes the legacy P2P graph. Legacy findings
  remain visible as engineering debt without contaminating Matrix shipping
  claims.

The detailed boundary rationale and stopped decisions are in
`mesh/docs/security/PHASE1_NATIVE_SECURITY_BOUNDARIES.md`.

## Verification record

Commands were run from `D:\Creations\Applications\mesh\mesh` unless noted.

| Command | Result |
| --- | --- |
| `git diff --check` | Passed |
| `npm run lint` | Passed, including copy-style guard |
| `npx tsc --noEmit` | Passed |
| `npm test -- --maxWorkers=1` | 106 files, 771 tests passed against the settled final renderer source |
| `npm run build:matrix` | Passed |
| `npm run check:bundle-size` | Passed all configured budgets |
| `npm run check:public-services` | Matrix.org, tchncs.de, and quassel.io discovery/versions/login checks passed on 2026-08-01; review expires 2026-08-29 |
| `npm run check:public-site` | Nine pages, local links, invitation safety, and social asset passed |
| `npm run check:readiness-ledger` | 24-gate ledger structurally valid |
| `node --test scripts/check-readiness-ledger.test.mjs` | 9/9 passed |
| `node --test scripts/check-external-acceptance.test.mjs` | 6/6 passed; tracked template has exactly 58 not-run cases |
| `npm run check:ai-boundary` | 4/4 validator tests and source guard passed |
| `npm run check:design-tokens` | Passed |
| `npm run check:icons` | Passed |
| `npm run check:ipc-contract` | 3/3 validator tests; 167 registered commands matched |
| `npm run check:ipc-types` | Generated Rust-to-TypeScript DTO contract current |
| `npm run check:security-invariants` | Matrix 19/19; legacy 13/13 |
| `npm run release:preflight -- -VerifyFrontendBundle` | Passed; Matrix-only signed candidate, draft prerelease only, no promotion path |
| `npm run matrixrtc:preflight` | Offline/configuration preflight passed and made no live claim |
| `npm run e2e -- --workers=1` | 67/67 Chromium tests passed |
| `npm run test:rust:matrix` | 190 library tests, generated-contract test, and deterministic helpers passed; environment-backed tests ignored as declared |
| `npm run test:rust:legacy` | 212 library tests, generated-contract test, 15 crypto tests, and deterministic TURN outcomes passed; environment/soak cases ignored as declared |
| Twenty repetitions of the filtered `member_presence_wait` Matrix integration helpers | 20/20 repetitions passed; both deadline/retry-after cases passed in every repetition |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | Passed |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --no-default-features --features matrix-backend --locked -- -D warnings` | Passed |
| `cargo audit --file src-tauri/Cargo.lock` | Expected nonzero: RUSTSEC-2026-0118 and RUSTSEC-2026-0119 in `hickory-proto 0.25.2`, reachable only through legacy `libp2p-mdns`; 25 allowed warning-class advisories also reported |
| `powershell -File scripts/check-matrix-release-dependencies.ps1` | Passed: zero known vulnerabilities, 7 reviewed runtime warnings, 1 build-only warning, and 2 explicitly legacy-only vulnerabilities |
| `python -m unittest infra/homeserver/tests/test_admission_service.py infra/homeserver/tests/test_configure_synapse.py` | 24/24 passed |
| `npm run setup:matrix-spike:reset` then `npm run test:matrix-spike` | Independent cycle 1: 2/2 passed |
| Same reset/test sequence from another reset | Independent cycle 2: 2/2 passed |
| `npm run release:preflight -- -VerifyFrontendBundle -RequireCleanSource -ExpectedSourceSha 45b1a2df6d71c826b17510a00f595c24b5d989ba` | Expected fail: worktree is not clean and therefore is not a release candidate |
| `npm run check:readiness-ledger -- --milestone R0 --require-live --commit-sha 45b1a2df6d71c826b17510a00f595c24b5d989ba --allow-ledger-only-commit` | Expected fail: `r0.dependency-advisory-policy` is blocked because no clean exact-SHA dependency evidence exists |
| `npm run matrixrtc:preflight -- -Production -RequireLiveAcceptance` | Expected fail: no external evidence root; all 23 cases are not-run; signed build, services, devices, networks, production values, clean source, and online mode are absent |

## Local versus external evidence

Verified locally:

- source-level and component behavior, deterministic native tests, browser E2E,
  production Matrix bundling, policy validators, and candidate-only workflow
  structure;
- live network discovery for the three reviewed independent public services;
- two disposable Synapse homeservers covering encrypted cross-service rooms and
  DMs, restart/offline exactly-once delivery, second-device history recovery,
  account-data reconciliation, room upgrades, moderation, and invitation-token
  registration.

Not verified as production acceptance:

- any signed installed build, provider registration, owner-operated service,
  physical assistive technology/WebView, public download/update route, or live
  MatrixRTC media path;
- protected CI or restore evidence for the uncommitted integrated source.

## External blocker ledger

| Gate and owner | Prerequisites | Exact acceptance procedure | Hard completion condition |
| --- | --- | --- | --- |
| Protected exact-SHA CI — repository/release administrators | Review changes, land them on protected `main`, select one clean source SHA | Run every required CI/security job and the two-iteration Linux restore workflow on that SHA; retain immutable artifacts and hashes | All required checks pass on the same source SHA; no local run substitutes |
| Admission verifier and issuer — Mesh security, identity, and community operations | Approve a POST-capable cryptographically bound verifier; provision a rotatable admission-only issuer and non-admin bot | Pass wrong-user/service/purpose/subject, expiry, replay, revoke, rotation, membership, recovery, and secret-observation tests against the deployed service | No reusable client token, credential-bearing URL, server-admin credential, log/IPC secret, or cross-community authority |
| Authoritative moderation audit — Mesh security and community governance | Approve access-restricted append-only storage, federation/provenance, retention, and export contract | Pass historical sender authority, failed outcome, forgery, demotion, cross-community, malformed, replay, retention, export, and unauthorized-reader cases | Authorized readers receive historically verifiable records; all other readers fail closed |
| Windows/provider acceptance — release and identity operations | Non-placeholder version, protected signing, production OAuth registrations and callbacks, signed candidate | Complete every `windows.*` and `provider.*` case in `mesh/release/external-acceptance.example.json` on a clean Windows machine; attach sanitized hashed evidence | All cases pass against the exact signed candidate; uninstall/residue and provider revocation included |
| Community-hosted operations — Mesh community-hosting operator | Public DNS/TLS, federation, backups, monitoring, rate/abuse controls, key and migration custody | Complete every `community-hosted.*` case, including federation from an independently hosted account and two destructive restores | Two separately evidenced restore cycles and every operational case pass without coupling account hosting to the community service |
| Manual accessibility — Mesh product accessibility | Signed builds on supported platforms plus NVDA, VoiceOver, Orca, WebView2, WKWebView, and WebKitGTK environments | Complete every `accessibility.*` case at keyboard-only, 200% zoom, large text, reduced motion, and high contrast; attach sanitized evidence | Every case passes on the signed build; automated axe results alone do not count |
| Public-service review — Mesh product/privacy | Current service terms/privacy/registration review and live discovery | Complete the three `public-service.*` cases, record reviewer/date/expiry, and re-review before 2026-08-29 | Each advertised service has current durable evidence or is removed from release configuration |
| Public release/update/legal — release operations and legal owner | Verified draft candidate, checksums, SBOM, provenance, legal approval, canonical route, updater key/endpoint/rollback contract | Complete pre-public `public-release.*` checks, approve promotion, publish deliberately, then verify GitHub asset, canonical latest route, signed updater/rollback, and live download | Every result and artifact is bound symmetrically to the same SHA/tag; updater remains disabled until then |
| MatrixRTC — voice/security operations | Trusted authorization service, SFU, TURN, two independent homeservers, physical devices/networks, signed build, approved operator | Store evidence outside the worktree and run all 23 cases in `mesh/infra/matrixrtc/acceptance-matrix.example.json`; then run `npm run matrixrtc:preflight -- -Production -Online -RequireLiveAcceptance -EvidenceRoot <root> -AcceptanceEvidenceFile <file>` | 23/23 pass with verified media E2EE, rotation, revocation, reconnect, hostile-network, multi-party, device-change, and cross-service evidence |
| macOS/Linux native invitations — desktop release owner | Signed/notarized packages and approved platform handlers | Complete `native-invite.macos-*` and `native-invite.linux-*` installed-protocol and cold-start cases | All four cases pass before those platforms are advertised as supported |
| Legacy Hickory debt — upstream rust-libp2p/Hickory maintainers and Mesh LAN owner | Upstream dependency release compatible with a fixed Hickory version; RUSTSEC-2026-0118 currently has no fixed upgrade | Upgrade without expanding ignores, run full legacy tests/audit, and preserve Matrix graph separation | Raw advisory is resolved upstream or the legacy product is retired; it is never described as fixed while present |

## Git and cleanup snapshot

- Branch: `codex/publish-main`.
- HEAD and local `main`: `45b1a2df6d71c826b17510a00f595c24b5d989ba`.
- `origin/main`: `72f093c84621183073ec43e233cfe0a26a1ca5f2`.
- Relationship: current HEAD is 0 behind and 13 commits ahead of `origin/main`.
- The current worktree is intentionally dirty and contains the implementation
  plus preserved concurrent visual-QA work: 139 modified paths, 2 deleted paths,
  and 62 untracked paths. Nothing is staged. Nothing was committed, pushed,
  tagged, published, deployed, or released.
- The concurrent renderer edit stream settled before the final build and browser
  campaign; no renderer source write occurred after that campaign's recorded
  start timestamp.
- No `mesh.exe` process was running, so none was stopped. The existing visual
  preview server at PID 32956 was preserved. The disposable Matrix containers,
  network, generated runtime, Playwright reports, test results, and production
  bundle directory were removed after verification.

The machine-readable gate state is `mesh/release/readiness.json`; the 58-case
external campaign template is `mesh/release/external-acceptance.example.json`.
