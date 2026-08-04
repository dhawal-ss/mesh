Mesh owner decision packets
===========================

:Status: Approved for the first public beta on 2026-08-03.
:Contract version: 2026-08-03.1
:Approval authority: Product-owner decision authority explicitly delegated to
  the Mesh technical lead on 2026-08-03.
:Scope: Product and release contracts that cannot be safely inferred from code,
  Matrix interoperability, or local tests.

``release/owner-decisions.json`` is the machine-readable authority. The detailed
packets below preserve the alternatives, trade-offs, tests, and stop conditions;
if narrative text conflicts with the approved register, the machine-readable
contract controls and the conflict blocks release.

Approved decision register
--------------------------

``D1 — Decrypted media``
  Use session-only decrypted media. Mesh-managed cache storage must not retain
  decrypted attachment bytes after the session boundary; explicit user exports
  remain user files. Implementation is required before a candidate. Rollback
  owner: security/privacy.

``D2 — Community ownership``
  Present one canonical owner derived from standard Matrix authority, but do not
  offer ownership transfer in the beta. Supported room versions do not provide
  an honest universal transfer of immutable creator authority. Do not invent a
  custom owner event or claim atomic community-wide authority. Rollback owner:
  protocol architecture.

``D3 — Moderation history``
  Ship immediate per-room action receipts only. Do not call a local database,
  ordinary room messages, or best-effort outcomes an authoritative audit log.
  A signed append-only audit system is a separate reviewed protocol project.
  Rollback owner: trust and safety.

``D4 — Community admission``
  Use standard Matrix invitation and knock flows. Keep the optional managed
  admission service disabled and fail-closed until a POST-capable token verifier
  and least-privilege registration issuer are reviewed. Community hosting must
  never force account hosting. Rollback owner: identity infrastructure.

``D5 — Destructive-action confirmation``
  Use risk-tiered confirmation. Local destructive actions require a native,
  one-use, operation/account/target-bound presence grant with a 60-second maximum
  lifetime. Server-authoritative destructive actions additionally require fresh
  provider or Matrix reauthentication. OS biometrics may strengthen local
  presence but never replace server authority. Unsupported paths fail closed.
  Rollback owner: security identity.

``D6 — Windows installation``
  NSIS current-user is the canonical consumer installer. MSI remains a secondary
  managed-deployment artifact. Cross-format replacement is blocked with plain
  guidance in the beta; there is no silent side-by-side installation or automatic
  migration. Uninstall retains user data by default and any erase action is
  separate and explicit. Rollback owner: Windows release.

``D7 — First release``
  Use version ``0.2.0`` and tag ``v0.2.0``. GitHub's prerelease state communicates
  beta status; the numeric three-part version preserves deterministic Windows
  Installer upgrade ordering. Publish only a signed draft prerelease until
  exact-version acceptance completes. Automatic updates remain disabled. The
  project remains ``AGPL-3.0-only`` and accepts contributions under DCO 1.1,
  inbound equals outbound, with no CLA for this beta. Never reuse released tag or
  artifact bytes. Rollback owner: release management.

``D8 — Optional community hosting``
  Offer no SLA. Publish only independently measured best-effort targets after two
  restore drills: daily backups, RPO target no more than 24 hours, restore target
  no more than 12 hours, and incident acknowledgement target no more than 24 hours
  when an operator is available. Rollback owner: community operations.

``D9 — Abuse controls``
  Ship standard Matrix moderation and transparent rate limits only. Do not ship
  global reputation scores or opaque automated anti-raid decisions. Future risk
  signals must be opt-in, explainable, human-reviewed, and appealable. Rollback
  owner: trust and safety.

``D10 — Mobile``
  iOS and Android are unsupported in the first beta. Do not advertise downloads
  or compatibility until a separate native product, security, notification, and
  release contract passes. Rollback owner: product platform.

``D11 — Apps and bots``
  Expose no third-party app or bot platform in the first beta. A later platform
  must be deny-by-default, capability-scoped, consented, observable, and revocable.
  Rollback owner: platform security.

The approval resolves product ambiguity; it does not assert that implementation,
external signing, legal review, physical-device acceptance, or production
operations evidence has passed.

Implementation snapshot
-----------------------

As of contract revision ``2026-08-03.3``, D1, D2, D3, D4, D5, D6, D9, D10,
and D11 have source implementations matching the approved beta behavior. D7 and
D8 have source configuration but still require external evidence. No approved
owner decision remains a source blocker, but candidate creation still requires
clean exact-SHA, signing, and external evidence. The current
authoritative blocker list is in ``release/owner-decisions.json``.

1. Decrypted media cache
------------------------

Decision
  Whether decrypted media is ephemeral only or may persist encrypted with an
  operating-system-bound key.
Options
  A. Delete decrypted bytes at view/session close and retain only encrypted source.
  B. Allow an opt-in, quota-bound persistent cache encrypted by an OS-keystore key.
Recommendation
  Ship A. Evaluate B only after physical power-loss, account-switch, key-loss,
  eviction, and secure-deletion tests.
Tradeoffs
  A minimizes disclosure and recovery complexity but costs bandwidth and offline
  access. B improves repeat viewing but adds key lifecycle, disk, backup, and
  forensic risk.
Owner
  Mesh product owner with security/privacy lead approval.
Migration and rollback
  B requires a versioned cache format and one-way opt-in migration. Rollback must
  delete the cache key and bounded cache without deleting encrypted Matrix media.
Acceptance tests
  Account switch, sign-out, keychain lock/loss, quota, low disk, crash, upgrade,
  uninstall/residue, and independent forensic inspection.
Stop condition
  Do not persist decrypted media or silently consume disk without this approval.

2. Community ownership transfer
--------------------------------

Decision
  One canonical owner versus multiple owners, including child-room recovery when
  authority differs across rooms.
Options
  A. One canonical community owner with explicit transfer.
  B. Multiple co-owners with a reviewed quorum/recovery rule.
Recommendation
  Prefer A for the first release, represented only through standard Matrix power
  levels and explicit per-room outcomes. Do not claim atomic transfer across rooms.
Tradeoffs
  A is understandable but creates succession risk. B reduces single-person risk
  while making revocation, disagreement, compromise, and federation much harder.
Owner
  Mesh product owner and Matrix protocol/security reviewer.
Migration and rollback
  Version the transfer plan, snapshot every affected room's power levels, and
  provide a dry run. Rollback restores only reviewed prior power levels where the
  current server still authorizes it; partial results must remain visible.
Acceptance tests
  Mixed authority, inaccessible child room, remote owner, concurrent change,
  compromised device, partial failure, cross-service federation, and recovery.
Stop condition
  Do not invent a custom ownership event or imply community-wide atomic authority.

3. Moderation audit authority
-----------------------------

Decision
  Source of truth, append authority, privacy, retention, federation, export, and
  replay/forgery rules for an administrator-action history.
Options
  A. Keep only immediate per-room action receipts and make no durable audit claim.
  B. Adopt a reviewed append-only service/room contract with signed entries.
Recommendation
  Ship A. Treat B as a protocol and trust-system project requiring independent
  review; a local database is not authoritative federated history.
Tradeoffs
  A is honest but limits investigations. B helps accountability while exposing
  sensitive targets/reasons and creating forgery, redaction, retention, and export
  obligations.
Owner
  Trust and safety owner, privacy lead, legal reviewer, and Matrix protocol reviewer.
Migration and rollback
  B needs a versioned event/service contract and export format. Rollback stops new
  writes while preserving lawful exports and retention/deletion obligations.
Acceptance tests
  Forged/replayed entries, remote moderation, power loss, redaction, subject access,
  retention expiry, compromised writer, clock skew, export, and cross-client behavior.
Stop condition
  Do not label current per-action outcomes an authoritative moderation audit.

4. Admission verifier and bot authority
----------------------------------------

Decision
  POST-capable OpenID verification, issuer allow-listing, and least-privilege bot
  or service authority.
Options
  A. No managed admission service; use normal invitation/knock policy.
  B. A narrowly scoped service that verifies OpenID by POST and performs only the
  approved admission action.
Recommendation
  Keep A until B has a reviewed issuer contract, bot power level, egress list,
  credential rotation, rate limits, and denial behavior.
Tradeoffs
  B can make invitations simpler but creates a public abuse surface and privileged
  credential. A keeps infrastructure optional but has fewer managed controls.
Owner
  Community-service owner and security lead.
Migration and rollback
  Deploy B disabled, use a separate identity and key, and retain 404 while disabled.
  Rollback revokes the credential and route without invalidating normal invitations.
Acceptance tests
  Issuer mismatch, replay, expiry, POST-only verification, SSRF, rate limit, bot
  compromise, cross-service account, disabled route, credential rotation, and 404.
Stop condition
  Do not enable admission, public registration, or invent an issuer/bot credential.

5. Destructive user presence and re-authentication
--------------------------------------------------

Decision
  Proof of user presence for account deactivation, device removal, ownership or
  permission changes, and other destructive actions across password, OIDC, and OS
  authority.
Options
  A. Provider re-authentication for every destructive class.
  B. Risk-tiered proof: provider re-auth where supported, recent OIDC login, or an
  OS-native credential prompt under an explicit capability matrix.
Recommendation
  B, fail closed per action/provider. Confirmation text alone is not re-auth.
Tradeoffs
  A is strongest and least portable. B supports more providers but needs expiry,
  fallback, device, and downgrade rules.
Owner
  Identity/security owner with product approval.
Migration and rollback
  Introduce an action-to-proof matrix behind deny-by-default capability detection.
  Rollback disables unsupported actions rather than accepting weaker confirmation.
Acceptance tests
  Password/OIDC/no-password services, stale sessions, offline state, OS cancel,
  account switch, remote revocation, replay, clock skew, and accessibility.
Stop condition
  Do not infer provider support or weaken destructive actions to a generic dialog.

Implemented beta boundary
  Local account erasure, remote device revocation, and account deactivation use
  a native 60-second, one-use, account/action/target-bound grant. Device
  revocation and account deactivation additionally retain Matrix password/UIAA
  reauthentication. Browser-auth account paths and Matrix administrator-role
  changes fail closed until provider-backed reauthentication is available.
  Routine reversible kick and ban actions remain under D3/D9 moderation policy.

6. Canonical Windows installer
-------------------------------

Decision
  Canonical MSI versus NSIS semantics and cross-format install/update/uninstall
  behavior.
Options
  A. NSIS is the consumer canonical installer; MSI is an administrator-managed
  secondary format.
  B. MSI is canonical; NSIS is secondary or removed after migration evidence.
Recommendation
  A for the one-obvious-button consumer path, provided MSI/NSIS cross-grade and
  ownership rules are tested and only one canonical download is promoted.
Tradeoffs
  NSIS is familiar for consumers. MSI fits managed estates. Shipping both without
  a canonical owner risks duplicate installs, residue, and broken updates.
Owner
  Windows release owner and product owner.
Migration and rollback
  Stable product/upgrade identifiers, explicit detection of the other format, and
  a documented rollback installer. Never silently install side by side.
Acceptance tests
  Clean install, repair, same-version reinstall, upgrade, downgrade rejection,
  MSI-to-NSIS and reverse, per-user/per-machine, uninstall, data retention, residue,
  signature/timestamp, and rollback.
Stop condition
  Do not promote both formats as equivalent or delete either before migration proof.

Implemented beta boundary
  NSIS writes a current-user format marker and checks the managed MSI marker
  before copying files. MSI writes a machine format marker and checks the
  current user's NSIS marker in both UI and silent sequences. The MSI changes
  its registered publisher before product registration so Tauri's default
  cross-format migration path cannot silently uninstall it. Both formats tell
  the user to uninstall the existing format first and state that account data
  is kept. Same-format maintenance remains available and each uninstaller
  removes only its own format marker.

7. Version, legal, signing, updater, and publication
----------------------------------------------------

Decision
  First non-placeholder version and the approval chain for legal text, signing,
  timestamping, updater keys/endpoints, publication, promotion, and rollback.
Options
  A. Signed draft prerelease with updates disabled, then separately approve public
  promotion.
  B. Signed prerelease plus automatic updater from day one.
Recommendation
  A. Use the approved numeric three-part version only when R0/R1/R2 evidence is
  exact; provision updater keys as a later independently reviewed lifecycle.
Tradeoffs
  A reduces key and rollback risk but requires manual test installs. B improves
  patch delivery while making signing-key loss or a bad manifest high impact.
Owner
  Mesh product owner, legal approver, and release/security owner.
Migration and rollback
  Record version/tag/source/installer digests. Rollback withdraws promotion, keeps
  immutable evidence, and publishes no replacement under the same version.
Acceptance tests
  Legal review, certificate chain/timestamp, clean download, checksums, both SBOMs,
  provenance, draft-only behavior, key rotation, downgrade, bad update, and rollback.
Stop condition
  Use only ``0.2.0``/``v0.2.0`` for this candidate. Keep signing, public promotion,
  and any updater publication blocked until their independent evidence passes.

8. RPO, RTO, monitoring, and incident ownership
------------------------------------------------

Decision
  Measurable recovery objectives and named operational/incident coverage for each
  optional managed service.
Options
  A. No uptime SLA; publish explicit best-effort objectives and owner availability.
  B. A supported service with funded on-call and contractual objectives.
Recommendation
  A for the optional Mac-mini/community service, with owner-chosen numeric RPO/RTO
  based on two measured destructive restores; never market an unstaffed SLA.
Tradeoffs
  Tighter objectives require monitoring, off-site backups, staff, and recurring
  drills. Loose objectives reduce cost but must be disclosed before account choice.
Owner
  Infrastructure owner and incident commander, approved by product owner.
Migration and rollback
  Objectives are versioned operational policy. If coverage disappears, downgrade
  published claims and keep account-service alternatives prominent.
Acceptance tests
  Two independent restores, signing-key recovery, monitor failure, alert delivery,
  capacity, rate limit, operator absence, incident communications, and measured RPO/RTO.
Stop condition
  Do not publish the approved best-effort numbers until two measured restores
  support them, and do not invent an on-call roster or uptime claim.

9. Anti-raid and appeals
------------------------

Decision
  Approved signals, evidence minimization, human override, retention, transparency,
  and appeals routing.
Options
  A. Rate limits and standard Matrix moderation only.
  B. Additional local/service risk signals under a reviewed policy.
Recommendation
  Ship A. Consider B only with explainable minimal signals, human confirmation,
  short retention, false-positive measurement, and a named appeal destination.
Tradeoffs
  B can reduce raids but creates profiling, bias, coordination, retention, and
  federation risks. A reacts later but preserves interoperability and privacy.
Owner
  Trust and safety owner, privacy/legal reviewer, and community governance owner.
Migration and rollback
  B must be feature-gated with signal/version audit. Rollback disables scoring and
  deletes retained derived evidence under the approved policy.
Acceptance tests
  Coordinated joins, false positives, accessibility, offline service, adversarial
  evasion, override, retention expiry, export/deletion, appeal, and remote users.
Stop condition
  Do not create global reputation, universal appeals, or private-member ranking.

10. Mobile platform contract
----------------------------

Decision
  Minimum iOS/Android versions and secure storage, background, notification,
  deep-link, recovery, distribution, and support promises.
Options
  A. Keep mobile out of the supported release.
  B. Approve separate native platform contracts and physical acceptance matrices.
Recommendation
  A until B is funded and owned. A responsive desktop webview is not mobile proof.
Tradeoffs
  Mobile expands reach while adding background limits, notification privacy,
  keystore migration, store review, device diversity, and long-lived support cost.
Owner
  Mobile product/engineering owner, security lead, accessibility owner, and release owner.
Migration and rollback
  Separate package identities/channels and capability flags. Rollback delists or
  disables unsupported capabilities without stranding account recovery.
Acceptance tests
  Minimum OS devices, secure-store lock/migration, background sync, notification
  privacy, deep links cold/warm, account switch, recovery, offline, AT, upgrade,
  uninstall/residue, and store distribution.
Stop condition
  Do not begin supported mobile implementation or claims without this contract.

11. Apps and bots
-----------------

Decision
  Identity, capability, egress, secrets, review/signing, revocation, audit, and
  distribution model for apps/bots.
Options
  A. No third-party app/bot platform in the supported release.
  B. Rust-owned deny-by-default capabilities with explicit community/user consent.
Recommendation
  A now. Design B as a separately threat-modeled platform with bounded room/event
  visibility, visible activity, quotas, isolated secrets, and immediate revocation.
Tradeoffs
  B enables integrations but creates a high-value code, data, permission, and
  distribution boundary. A limits extensibility but keeps trust understandable.
Owner
  Platform product owner, security/privacy lead, and community governance owner.
Migration and rollback
  Version signed manifests and capabilities. Revocation must stop execution and
  egress immediately while preserving a minimal, privacy-reviewed audit record.
Acceptance tests
  Malicious manifest, confused deputy, permission escalation, secret exfiltration,
  rate limit, offline revocation, update/signing compromise, user visibility,
  export/deletion, federation, and incident response.
Stop condition
  Do not implement a custom app event, shared checklist event, or unreviewed bot authority.
