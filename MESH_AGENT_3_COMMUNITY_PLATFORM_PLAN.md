# Mesh Agent 3 - remaining community, moderation, and product platform work

## Mission

This is the second-wave brief. Turn the first-wave role preview into a truthful
projection of real Matrix state, then implement the highest-value remaining
community/product features without weakening interoperability, privacy,
accessibility, or bundle budgets.

The goal is not a screen-for-screen Discord clone. Mesh should combine calm
organization, fast community fluency, trustworthy decentralized identity,
serious voice expectations, and structured long-form discussion while hiding
infrastructure from normal users.

Read before changing anything:

- `AGENTS.md`
- `MESH_COMPETITIVE_PRODUCTION_PLAN_2026-07-30.md`
- `PRODUCTION_BETA_PLAN.md`
- the complete current `git status` and diffs for every file you intend to edit

## Verified starting point and known gaps

The first wave already added:

- owner/administrator/member role templates mapped to Matrix power levels;
- role-change confirmation and permission preview UI;
- protection of `m.room.power_levels` at owner level for Mesh-created Spaces
  and rooms;
- targeted permission and member-list tests.

The post-wave audit found:

1. `RolePermissionPreview` falls back to a hard-coded default policy when no
   policy is supplied. Existing, federated, or manually changed rooms can
   therefore display misleading "effective" permissions.
2. Role templates are only the first slice of the previous brief. Guided member
   onboarding, forums, non-media events/stages, scoped integrations, native
   polls, stickers, GIF privacy, voice notes, safe link previews, scale
   validation, i18n, and mobile strategy remain.
3. Custom emoji already exists in the baseline. Extend it only where a verified
   gap exists; do not create a duplicate emoji system.
4. Live stages must remain gated on Agent 2's RTC evidence.
5. The bundle is close to its hard limits. The last audit measured roughly
   200.95 / 350 KiB entry, 513.27 / 525 KiB eager JavaScript,
   1955.24 / 2048 KiB all JavaScript, 74.52 / 100 KiB CSS,
   332.28 / 400 KiB fonts, and 2362.04 / 2500 KiB total. The eager budget has
   very little headroom.

Treat this as a snapshot and remeasure after your changes.

## Parallel ownership contract

All three agents may be using the same dirty `main` checkout.

- Do not create a branch, stage, commit, push, deploy, release, reset, stash,
  clean, or discard changes.
- Preserve all tracked and untracked work.
- Before every edit, run `git diff -- <path>` and reread the file.
- Do not run a repository-wide formatter.
- Run focused tests with one worker during parallel work.
- Rust commands must use `--jobs 1` or `CARGO_BUILD_JOBS=1`.
- Do not add dependencies or change a lockfile during the parallel phase. If a
  dependency is truly necessary, produce a compatibility/security/bundle
  request for Agent 1's final barrier.
- Lazy-load every substantial forum, integration, picker, or settings surface.

### Files owned by this lane

- `mesh/src/components/community/**`
- `mesh/src/components/chat/**`
- new community/product leaf components under `mesh/src/components/`
- `mesh/src/store/communities.ts`
- `mesh/src/store/channels.ts`
- `mesh/src/store/custom-emoji.ts`
- `mesh/src/lib/community-permissions.ts`
- `mesh/src/lib/community-permissions.test.ts`
- community, onboarding, forum, event, integration, poll, sticker, GIF,
  voice-note, preview, and scale leaf modules/tests newly created under
  `mesh/src/lib/`
- `mesh/src/lib/moderation.ts`
- `mesh/src/lib/moderation.test.ts`
- `mesh/src-tauri/src/backend/matrix/moderation.rs`
- new community/platform Rust leaf modules and tests under
  `mesh/src-tauri/src/backend/matrix/`
- new architecture/performance documents owned by this lane

Agent 1 owns account onboarding/OIDC/security-device files. Agent 2 owns
`matrix.rs`, voice/RTC, federation harness, release, operations, Cargo
manifests, and infrastructure. Do not edit those paths.

The following are shared integration files and remain read-only:

- `mesh/src/App.tsx`
- `mesh/src/lib/bridge.ts`
- `mesh/src/types/ipc.generated.ts`
- `mesh/src-tauri/src/backend/matrix.rs`
- `mesh/src-tauri/src/lib.rs`
- `mesh/src-tauri/src/commands/**`
- `mesh/package.json`
- `mesh/package-lock.json`
- `PRODUCTION_BETA_PLAN.md`

Build leaf APIs and include exact registration/hook requests in the handoff for
Agent 1.

## C0 - make role permissions truthful for every room

Remove the default-policy illusion.

Implement:

1. A backend leaf API that reads the current `m.room.power_levels` event for
   the community Space and each relevant child room.
2. A typed projection covering user levels, `users_default`, `events`,
   `events_default`, `state_default`, bans, kicks, invites, redaction, and
   notification thresholds.
3. Per-room outcomes: loaded, missing/defaulted by Matrix semantics,
   inaccessible, unsupported, and failed.
4. A community aggregate that distinguishes:
   - granted everywhere;
   - granted in some rooms;
   - not granted;
   - unknown because one or more authoritative rooms could not be read.
5. An explicit template preview separate from current effective permissions.
   Never label a template as current server state.
6. Refresh after role changes, room addition/removal, sync restart, and remote
   power-level updates.
7. Existing/federated room support. Do not assume Mesh-created defaults.
8. Last-effective-owner and privilege-escalation protection based on
   authoritative state, not a locally selected role label.

`RolePermissionPreview` must require an explicit policy/loading/error input. If
authoritative state is unavailable, show "Unable to verify permissions" with a
retry/diagnostic action, not the default template as fact.

Acceptance:

- tests cover a Mesh-created community, divergent child-room thresholds,
  manual remote edits, a missing/inaccessible room, partial failure, restart,
  and a federated room;
- the UI distinguishes current, proposed, partial, and unknown;
- lower roles cannot grant themselves protected state-event control;
- the last effective owner cannot remove the final recovery path;
- permission tests assert resulting Matrix state, not hidden buttons.

During parallel work, implement the backend reader as a leaf module and provide
the exact `matrix.rs`/command/bridge integration request.

## C1 - guided community entry and information architecture

Make a new member understand a community and send a first message in under one
minute.

Deliver:

- invitation preview with community name, icon, description, trust/service
  context, and clear account/community hosting independence;
- welcome surface with purpose, rules, and next steps;
- optional interests that recommend rooms but never silently join or hide the
  full directory;
- starter tasks: read rules, introduce yourself, choose rooms, review
  notifications;
- categories represented by interoperable Spaces/nested Spaces, not local-only
  folders;
- searchable room directory with topic, membership/invite state, and join;
- sensible notification review in plain language;
- actionable empty, loading, offline, permission, expired-invite, and partial
  federation states;
- complete keyboard, focus, screen-reader, reduced-motion, zoom, and small
  window behavior.

Acceptance:

- a first-time user can accept an invite, understand the community, choose
  rooms, and send a first message without protocol vocabulary;
- optional rooms and notifications change only after explicit user action;
- structure remains intelligible in another compatible Matrix client;
- focused tests cover keyboard and assistive status announcements.

Do not edit Agent 1's account-service chooser. Expose a leaf step/component and
request the precise onboarding hook.

## C2 - forum MVP and non-media events

### Forum MVP

Use standard Matrix rooms, threads/relations, edits, and redactions wherever
possible.

Deliver:

- forum index with title, author, tags, reply count, last activity, unread,
  solved/closed state, pagination, loading, and retry;
- create, reply, edit, redact, close/reopen, moderate, and search flows;
- deterministic projection after restart, back-pagination, remote events,
  duplicate delivery, out-of-order relations, and redaction;
- a useful fallback in compatible clients for any Mesh-specific tag/solved
  metadata;
- no second authoritative message cache.

### Events and stages

Implement the non-media portion only:

- scheduled event details, timezone-safe display, reminders, RSVP, speaker
  request state, and moderator/audience layouts;
- truthful "live voice unavailable" behavior until Agent 2 provides
  `LIVE_RTC_ACCEPTED`;
- no decorative mute/remove state that is not enforced by the media/server
  system.

Acceptance:

- forum state survives restart and remote synchronization;
- edits/redactions/pagination cannot corrupt the index;
- event reminders respect notification/privacy settings and timezone changes;
- stage/media controls remain capability-gated.

## C3 - scoped integration foundation

Build the least-privilege model before any marketplace.

Deliver:

- versioned manifest: integration identity, publisher, support/privacy URLs,
  requested capabilities, room targets, event scopes, destinations, expiry;
- install review showing exactly what the integration can read and do;
- renderer-safe credential handles with secrets held behind the native/server
  boundary;
- per-room/community grants, immediate revocation, rotation, disable/uninstall,
  and audit history;
- bounded outgoing webhook schemas, idempotency, retry/backoff, rate limits,
  and secret-safe delivery logs;
- incoming webhook identity that cannot impersonate arbitrary users or bypass
  room permissions;
- explicit encrypted-room plaintext consent and architecture review.

Do not build a marketplace, remote-code execution host, or production bot
service. If a trusted server component is unavailable, finish the manifest,
policy engine, UI, mocks, and tests, then leave installation disabled.

Acceptance:

- one-room send permission cannot read history or post elsewhere;
- revocation survives restart and takes effect promptly;
- secrets never appear in renderer IPC, normal logs, exports, or errors;
- users can inspect grants, recent actions, data destinations, and removal.

## C4 - high-value expression and retention

Implement in this order and stop before starting a later item if an earlier
acceptance gate is not complete:

1. Native Matrix polls with edit, vote change, close, redaction, restart, and
   compatible-client fallback tests.
2. Sticker packs integrated with the existing custom-emoji system, including
   permission, attribution, bounded cache, fallback, and removal.
3. Voice notes using the existing encrypted attachment/grant boundary, with
   recording consent, accessible playback, cancellation, duration/size limits,
   and no plaintext persistence.
4. GIF search only behind explicit provider disclosure, a disable switch,
   bounded queries/cache, and no provider request before consent.
5. Safe link previews only through a trusted fetch boundary with scheme
   allowlisting, DNS rebinding defenses, redirect revalidation, blocked
   loopback/link-local/private/metadata destinations, byte/time/type limits,
   bounded cache, and per-user disable.

If a safe trusted preview/GIF service does not exist, implement the setting and
capability-unavailable state; do not fetch directly from the renderer or weaken
SSRF/privacy boundaries.

Acceptance:

- standard event/fallback behavior works in another compatible client where
  possible;
- all features survive restart and remote synchronization;
- media/cache/disk use is bounded and observable;
- privacy disclosure occurs before a third-party request;
- URL safety tests cover literal, encoded, redirected, IPv4, IPv6, DNS, and
  metadata-service targets.

## C5 - scale, accessibility, i18n, and platform decisions

Create an ADR and removable spike for the pinned Matrix SDK's room-list and
event-cache/UI layers. Do not change dependencies or production state
management during parallel work.

The ADR must compare:

- current custom projections;
- pinned SDK room-list/event-cache behavior;
- encrypted-event and pagination semantics;
- restart and out-of-order consistency;
- generation-token/stale-update protections;
- memory/CPU behavior on a synthetic large community;
- migration, rollback, and single-authority strategy;
- measurable adoption and rejection criteria.

Also provide:

- a synthetic large-community fixture and repeatable performance harness;
- budgets for initial sync, room switch, message render, search, memory, and
  CPU;
- keyboard/focus/screen-reader/reduced-motion/contrast/zoom coverage for new
  surfaces;
- an i18n extraction plan with stable message IDs and no concurrent dependency
  migration;
- a documented mobile decision: responsive desktop, separate native client, or
  deferred. Do not call desktop responsiveness a mobile application.

Acceptance:

- no dual authoritative cache;
- stale async results cannot overwrite newer room state;
- the spike is isolated and removable;
- bundle budgets remain green and large features are lazy-loaded;
- performance evidence includes cold/large-fixture behavior.

## Verification

Run focused tests during parallel work:

```powershell
cd mesh
npx vitest run src/components/community src/lib/community-permissions.test.ts --maxWorkers=1
npx vitest run src/components/chat --maxWorkers=1
npx vitest run src/lib/moderation.test.ts --maxWorkers=1

$env:CARGO_BUILD_JOBS='1'
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --features matrix-backend --locked --jobs 1 moderation
```

Add focused test commands for every new leaf module. Before handoff, when no
other agent is building:

```powershell
cd mesh
npm run lint
npx tsc --noEmit
npm test -- --maxWorkers=1
npm run build
npm run check:design-tokens
npm run check:icons
npm run check:bundle-size
git diff --check
```

If shared IPC integration is still pending, run every leaf test and clearly
label full build/runtime behavior as pending Agent 1 integration.

## Stop conditions

Stop and report, rather than guess, when work requires:

- a dependency or lockfile change;
- editing a shared file or Agent 1/2-owned path;
- a production bot token, webhook secret, provider contract, or remote service;
- deploying AutoMod, link-preview, GIF, integration, or event infrastructure;
- destructive reset of real community/user data;
- enabling stages without Agent 2's `LIVE_RTC_ACCEPTED` evidence;
- a client-only permission/moderation control that the server cannot enforce;
- sending encrypted plaintext to an integration without explicit scoped consent
  and security review;
- exceeding a bundle budget without an approved architectural change.

## Required handoff

Create `MESH_AGENT_3_WAVE2_HANDOFF.md` containing:

- files changed and root causes fixed;
- current/proposed/partial permission evidence;
- guided onboarding and forum acceptance results;
- interoperability behavior in another Matrix-compatible client;
- integration/expression security and privacy tests;
- accessibility, performance, and bundle measurements;
- every capability that remains disabled;
- exact shared-file/IPC integration requests for Agent 1;
- unresolved service/external blockers;
- an explicit verdict: `LEAF_WORK_READY_FOR_INTEGRATION`,
  `COMMUNITY_BETA_LOCALLY_ACCEPTED`, or `BLOCKED`, with reasons.

Do not edit `PRODUCTION_BETA_PLAN.md`; Agent 1 will reconcile it from this
handoff after all agents stop.
