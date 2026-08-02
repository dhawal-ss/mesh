Post-beta product backlog specification
=======================================

:Status: dependency-ordered specification; no release claim
:Authority: ``AGENTS.md``, current typed Matrix backend, and standard Matrix behavior
:Stop rule: an owner decision is not a coding task

This backlog deliberately separates behavior Mesh can implement with existing
protocol and product authority from behavior that needs a reviewed contract.
Account hosting, community hosting, and optional admission remain independent.
No item may make MatrixRTC, a custom event, or an operator service silently
mandatory for normal text/community use.

Dependency order
----------------

P0. Preserve the current release boundary
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Dependencies
  None.

Authoritative work
  Keep the Matrix-only text/community beta contract, explicit account-service
  choice, custom-service path, encryption quarantine, bounded native work, and
  fail-closed voice state intact. Add a feature only after its capability and
  privacy gates can be represented by the Rust backend.

Acceptance
  Existing release, IPC, privacy, accessibility, and external-acceptance checks
  remain green. The public artifact contains neither legacy P2P nor unapproved
  voice assets.

Stop conditions
  Stop if a later item requires weakening service choice, reading quarantined
  content, inventing federated deletion, or enabling an unapproved custom event.

P1. Newcomer onboarding and community checklist
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Dependencies
  P0; reliable invitation/account/community entry; current room membership and
  permissions projection.

Authoritative implementation slice
  Build a local, reversible checklist from facts Mesh already knows: account
  signed in, invitation resolved, community joined, selected channel opened,
  and first message draft opened. Keep it presentation-only; derive completion
  from Matrix membership and local UI state. Place the model under
  ``src/lib/onboarding-checklist.ts`` and the lazy UI under
  ``src/components/community/``. Do not write custom Matrix state for this
  slice. Provide keyboard, 320 px, 400% zoom, reduced-motion, and screen-reader
  coverage.

Acceptance
  A new member can dismiss and reopen the checklist; account switching cannot
  leak completion between accounts; offline state never marks a network step
  complete speculatively; no infrastructure terminology enters the default
  path.

Owner decisions before any shared/admin-authored checklist
  Decide the allowed step vocabulary, who may author or reorder steps, whether
  completion is private or shared, retention/deletion, cross-device storage,
  and the standard Matrix representation. Until approved, do not create an
  ``org.mesh.*`` checklist event.

P2. Polished standard Matrix threads
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Dependencies
  P0; existing ``threadRootId`` send/reply projection, relations, receipts,
  edits, redactions, search, and unread reconciliation.

Authoritative implementation slice
  Use standard Matrix ``m.thread`` relations only. Add a thread panel and
  accessible open/close navigation, root preview, reply count, last activity,
  unread/mention state, permalink routing, and thread-aware search results.
  Preserve edits, redactions, encrypted attachments, receipts, and offline send
  semantics. Work through ``src-tauri/src/backend/matrix/messages.rs``, the
  typed bridge, and lazy components under ``src/components/chat/``.

Acceptance
  Root and replies remain in one encrypted room; thread replies never appear as
  unthreaded sends; unread state survives restart and another device; keyboard
  focus returns to the invoking message; malformed or undecryptable relations
  are quarantined without hiding the main timeline. Federation acceptance must
  cover two services and offline recovery.

Stop conditions
  Do not add a custom thread event, server-side plaintext index, or thread
  retention rule. Stop if the SDK cannot preserve standard relations and
  encrypted-history correctness.

P3. Forums and events
~~~~~~~~~~~~~~~~~~~~~

Dependencies
  P2 for discussion threads; P1 for optional discovery presentation.

No implementation is currently authorized
  Matrix rooms and threads supply useful primitives, but Mesh has no reviewed
  contract for forum post metadata, tags, sorting, event time zones, RSVP
  state, recurrence, cancellation, reminders, or moderation/retention.

Owner decisions
  Select stable standard Matrix event types or approved MSCs; define fallback
  behavior for other clients; decide tag and RSVP authority, edits, redactions,
  recurrence, notification defaults, privacy, export, retention, and migration.
  Decide whether a forum is a room view or a distinct room type. Record a
  compatibility/licensing review before adopting upstream implementations.

Acceptance after approval
  Unknown metadata remains readable as an ordinary room/thread in compatible
  clients; time handling is explicit and locale-safe; encrypted rooms do not
  leak titles or attendance; moderation and redaction follow authoritative room
  state; all custom behavior has versioning and downgrade tests.

P4. Applications, anti-raid controls, and appeals
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Dependencies
  P0; current knock-based applications, room join rules, power levels,
  per-room moderation outcomes, and truthful absence of authoritative audit.

Authoritative implementation slice
  Polish the existing standard knock/application queue: bounded pagination,
  refresh, accessible approve/deny confirmation, stale-request handling, and
  per-room outcome reporting. Use Matrix membership and power levels as the
  authority. Improve operator documentation for Synapse rate limits and
  emergency registration closure without turning them into end-user choices.

Acceptance
  A stale application cannot be approved; one inaccessible child room does not
  hide other results; approval never forces account hosting onto the community
  service; denial copy does not promise a universal appeal; moderation copy
  distinguishes removal (may rejoin) from ban (prevented until reversed).

Owner decisions before anti-raid automation or appeals
  Decide signal sources, thresholds, false-positive recovery, human override,
  evidence minimization, retention, federation scope, who adjudicates appeals,
  response expectations, and whether an append-only audit service exists.
  Do not build automated bans, a global reputation system, or a universal
  appeal promise without this authority.

P5. Certified persistent voice rooms
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Dependencies
  All 23 physical MatrixRTC cases; real SFU/TURN conditions; membership-bound
  media-E2EE approval; signed installed builds; operations and support approval.

Current action
  Keep MatrixRTC unavailable. Continue using the checked physical evidence
  schema and fail-closed capability state. No local validator or disposable
  federation run substitutes for physical/live proof.

Owner decisions after certification
  Define what “persistent” means when nobody is connected, occupancy and
  history retention, text-room association, moderation authority, recording
  prohibition/consent, guest access, service failure behavior, and supported
  platform/network matrix.

Acceptance after approval
  Every checked case binds source commit/tree, installed artifact digest,
  device/OS/network topology, SFU/TURN conditions, media-E2EE result, and
  reviewer approval. Late join, key rotation, reconnect, device switch,
  federation, relay-only paths, and revocation fail closed. Microphone, camera,
  and screen remain off until explicit user action.

P6. Mobile acceptance
~~~~~~~~~~~~~~~~~~~~~

Dependencies
  Stable P0-P4 protocol behavior; a separately approved mobile shell and secure
  storage design.

No mobile implementation is currently authorized
  Desktop Tauri acceptance does not establish iOS or Android lifecycle,
  notification, background sync, key storage, deep-link, media, or accessibility
  behavior.

Owner decisions
  Choose supported OS/device minimums, distribution channels, secure-storage
  primitives, background limits, notification privacy defaults, universal/app
  link ownership, backup/recovery UX, update policy, telemetry policy, and
  whether voice enters the first mobile milestone.

Acceptance after approval
  Test clean install/upgrade/removal, invitation links, service choice, account
  switching, encrypted offline recovery, background/foreground transitions,
  revoked devices, notification redaction, low storage/battery/network changes,
  Dynamic Type/font scaling, screen readers, keyboards/switch controls, and
  cross-service federation on physical devices. Evidence is platform- and
  artifact-bound.

P7. Capability-scoped apps and bots
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Dependencies
  P0; authoritative permission projection; reviewed app identity and revocation
  model; trustworthy audit contract if privileged actions are permitted.

No general app platform is currently authorized
  Do not add arbitrary JavaScript/CSS injection, renderer-held access tokens,
  broad Matrix credentials, autonomous AI actions, or a bot that silently joins
  rooms. Existing admission identity remains a narrow infrastructure role, not
  an app platform.

Owner decisions
  Define app identity, installation consent, room/community scope, capability
  vocabulary, secret storage, token lifetime, network egress, data visibility,
  user-visible activity, rate limits, review/signing/distribution, revocation,
  export/deletion, federation behavior, appeals, and incident response. Decide
  which capabilities, if any, may mutate membership or moderation.

Acceptance after approval
  Rust is the final authority for every capability check; default is deny;
  grants are explicit, bounded, observable, and reversible; revocation stops
  native work before acknowledgement; account switching cannot reuse grants;
  an app sees no quarantined or undecryptable content; support bundles and logs
  contain no app secrets. Negative tests cover confused-deputy and renderer
  spoofing attempts.

Verification contract for every implemented slice
-------------------------------------------------

Run TypeScript, lint, focused unit/component tests, IPC drift, privacy/security
checks, production builds, bundle budgets, Matrix Rust tests and strict Clippy,
formatting, Chromium E2E including accessibility/zoom, and the relevant
disposable federation cycle. Add physical, installed, provider, operator, or
mobile evidence when the slice crosses those boundaries. Record exact source
commit and tree hash; never promote a local or dirty-tree result into a release
claim.
