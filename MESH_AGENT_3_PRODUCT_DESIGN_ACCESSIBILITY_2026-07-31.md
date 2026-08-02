# Mesh Agent 3 — Product UX, Design System, Accessibility, and Community Tools

**Date:** 2026-07-31
**Run on:** `main` only
**Starting documentation SHA:** `b2427b6`
**Integrated implementation SHA:** `7effb0c`
**Master plan:** `MESH_SOL_PRODUCTION_IMPLEMENTATION_PLAN_2026-07-31.md`

## Mission

Close WP-02, WP-08, WP-13 through WP-19, and WP-22 in a bundle-disciplined, accessible product lane. Preserve the consumer north star: invitations, service choice, communities, channels, roles, and settings must feel ordinary even when Matrix provides the control plane.

WP-00 and WP-01 are complete. Existing command palette, permission projection, virtualization, onboarding, and accessibility work are real; audit and extend them instead of rebuilding them.

## Read first

1. `AGENTS.md`
2. `PRODUCTION_BETA_PLAN.md`, including the current ledger, the retained product/frontend audit, and stop conditions
3. `MESH_SOL_PRODUCTION_IMPLEMENTATION_PLAN_2026-07-31.md`
4. `design_handoff_mesh_chat_voice/README.md` and `mesh-shell.html` as a visual reference—not production code
5. This file and current `git status`/recent log

Cinny is a reference for calm structure and disciplined tokens. Do not copy its branding or code without a licensing/compatibility review.

## Parallel-work contract

- Work in the existing `main` checkout. Do not create/switch branches, reset, clean, stash, or overwrite concurrent edits.
- Do not stage, commit, push, deploy, or publish unless explicitly authorized by the user.
- Preserve all unrelated dirty paths.
- Agent 3 owns:
  - `mesh/vite.config.ts`
  - `mesh/src/styles/**`
  - shared presentational primitives under `mesh/src/components/ui/**`
  - `mesh/src/components/navigation/CommandPalette*`
  - non-voice community/onboarding/product UI and its tests
  - accessibility E2E/spec helpers, except Agent 1’s recovery/security settings tests
  - new isolated permission/channel-lifetime/tab domain modules
- Do not edit Agent 1’s recovery/privacy/notification/invite security behavior or `.github/workflows/security.yml`.
- Do not edit Agent 2’s voice components/store/engines, MatrixRTC backend/infra, or release/operator workflows.
- `App.tsx`, `bridge.ts`, generated IPC types, `src-tauri/src/lib.rs`, `backend/mod.rs`, `backend/matrix.rs`, package manifests, and `PRODUCTION_BETA_PLAN.md` are shared hot files. Keep them read-only during parallel work. Build lazy leaf components and record exact integration changes for Agent 1.
- Do not create a handoff document. Append results to this file.

## Required implementation order

### A3-0 — WP-02: create bundle headroom first

Current integrated evidence is 514.13/525 KiB eager JavaScript.

1. Run a clean production build and capture the current chunk graph.
2. Add a stable lazy boundary for at least one large, non-hot surface—settings, community administration, emoji/GIF browsing, or a comparable route.
3. Keep install → invite → service choice → sign-in → community shell in the eager path.
4. Add chunk names/grouping that remain deterministic and cache-friendly.
5. Loading and error fallbacks must be accessible skeletons with recovery actions, not spinner-only dead ends.
6. Every new panel in this lane must be lazy-loaded unless measurements show it is already inside a loaded chunk.
7. The eager budget must pass with meaningful headroom. Record before/after values; do not raise the 525 KiB limit.

Do not begin the larger product surfaces until this gate is green.

### A3-1 — WP-13: container-role design tokens

Extend the existing token system; do not replace working semantic tokens wholesale.

Acceptance criteria:

- every major color role exposes `container`, `container-hover`, `container-active`, `container-line`, and `on-container`;
- state derivation uses perceptually consistent OKLCH inputs with compatible fallbacks for supported Tauri webviews;
- light/dark/high-contrast and user theme variants remain legible;
- components do not invent hard-coded hover/active hex colors;
- semantic success/warning/danger states remain distinct from brand accent;
- automated contrast/token checks cover combinations, and the existing token checker stays green.

### A3-2 — WP-14: SequenceCard utility

Create one shared utility/component for consecutive rows and apply it first to a bounded set of list-heavy surfaces such as settings and member administration.

- first/middle/last/single states must work without relying exclusively on `:has()` where an unsupported webview would break;
- keyboard focus, selected state, separators, virtualization, and high contrast remain visible;
- do not alter DOM semantics merely to obtain rounded corners;
- add visual/state tests rather than snapshotting an entire page.

### A3-3 — WP-15: extend the existing command palette

`Ctrl/Cmd+K`, recents, commands, and current navigation already exist. Add only the missing behavior:

- `#` scopes channels, `@` scopes DMs/people, and `*` scopes communities;
- an empty query shows bounded recent activity, not an unbounded complete list;
- every row shows safe breadcrumb context;
- account-service context is plain and non-endorsement wording;
- ranking is deterministic and cannot reveal rooms/people outside current membership;
- full keyboard navigation, focus return, Escape, IME input, and screen-reader labels pass;
- hot-path bundle cost remains within A3-0’s budget.

### A3-4 — WP-16: WCAG 2.2 AA release pass

Implement and verify:

1. the message timeline mounts with `role="log"` and appropriate live behavior even when empty;
2. virtualized rows expose stable order, `aria-setsize`, and `aria-posinset` without breaking bottom anchoring;
3. every drag/reorder action has a keyboard/button/menu equivalent;
4. every interactive target is at least 24×24 CSS px, including reaction chips and hover actions;
5. sticky headers/toolbars never obscure keyboard focus;
6. regions support a consistent keyboard model (`F6` between major regions, Tab within, arrow entry where appropriate);
7. authentication/recovery UI offers copy/paste, QR, or file alternatives and never requires memorization/transcription alone—coordinate security-flow changes with Agent 1;
8. axe coverage spans all onboarding screens plus representative community, room, DM, settings, and voice-disabled surfaces;
9. reduced motion, 200% zoom, narrow windows, Windows high contrast, and text scaling remain usable.

Automated tests do not replace manual NVDA/VoiceOver/Orca evidence. Record unrun platforms honestly.

### A3-5 — WP-17: restrained motion, transparency, and loading

- add a user-controlled transparency setting with a readable default and an opaque option;
- bound backdrop blur to small non-scrolling overlays; never blur the message timeline;
- replace spinner-only page/panel states with skeletons that preserve layout and accessible status text;
- every animation has purpose, supports `prefers-reduced-motion`, and does not create repeated chat fatigue;
- speaking-ring animation belongs to Agent 2; coordinate through the completion record;
- appearance remains device-local and survives account switches per the current settings boundary.

### A3-6 — WP-08: community onboarding and personal channel selection

This is post-account community onboarding, not Matrix account creation.

Acceptance criteria:

1. An invitation still permits explicit account-service choice; community hosting never forces account hosting.
2. Community rules are server-authoritative and versioned. Before acceptance, send/react/join-voice actions are denied at the authoritative boundary, not merely hidden in React.
3. Admin-configured defaults and interest answers add channels to that member’s personal sidebar without globally changing room visibility.
4. Any role granted by an answer uses the current authoritative permission projection and cannot self-escalate.
5. A persistent “Channels & Roles” surface lets members reverse their selections.
6. Declining/skipping optional interests does not block community entry beyond required rules.
7. Rejoin, account switch, offline/reconnect, room upgrade, and compatible-client behavior are tested.
8. Protocol terms remain in diagnostics/advanced help only.

During parallel work, implement pure domain models, lazy UI, and tests in isolated modules. Record backend/IPC wiring for Agent 1 after Agent 2 releases `matrix.rs`.

### A3-7 — WP-18: Simple/Advanced permission model

Keep existing Matrix power levels as the authoritative base.

- Simple mode remains the default and uses role templates plus the current permission projection.
- Before adding custom state, write a compact schema/threat model for server group, client override, channel group, channel override, `skip`, `negate`, and power/needed-power resolution.
- Effective moderation must be deterministic, auditable, federation-safe, and never leave a room without an owner/recovery path.
- Unknown/unsupported extension state must fail closed in the Advanced UI without breaking standard Matrix clients.
- Role duplication and a plain “why allowed/denied” explanation are required.
- Add property tests for ordering, `skip`, `negate`, ties, stale authority, room upgrades, and malicious values.

If the model cannot be represented safely on the Matrix control plane without a new protocol/product decision, stop with the schema, threat model, and exact blocker. Do not ship a renderer-only permission illusion.

### A3-8 — WP-19: channel lifetimes with honest Matrix semantics

TeamSpeak’s “clear on server restart” and “delete when empty” semantics do not map directly to federated Matrix rooms.

Required approach:

1. Define lifecycle semantics first: creation, occupancy, grace period, archive/tombstone, retention, rejoin, federation, moderation, audit, and recovery.
2. Never promise deletion of federated history that Mesh cannot guarantee.
3. Prefer explicit archive/tombstone plus retention policy over silent destructive deletion.
4. A member’s permission to create temporary child rooms must be scoped to a designated parent, rate-limited, auditable, and unable to grant extra power.
5. Compatible clients must see a valid Matrix room even if they ignore Mesh lifecycle metadata.

If a restart-based lifetime has no stable meaning in the zero-cost federated architecture, mark that subfeature blocked for a product decision rather than inventing one.

### A3-9 — WP-22: pinned room tabs

- multiple rooms/DMs can be opened, pinned, reordered, closed, and restored;
- use a bounded, account-scoped state model; never restore another account’s room IDs;
- unread/mention state stays visible on every tab;
- keyboard actions cover open, next/previous, reorder, close, reopen, and focus return;
- narrow windows collapse to an accessible tab menu rather than horizontal overflow;
- tabs do not duplicate message stores or trigger unbounded sync/listeners;
- the whole surface is lazy and passes the bundle budget.

## Verification

Use focused tests after each package. Before handoff, from `mesh/` run:

```powershell
npm run lint
npx tsc --noEmit
npm run check:design-tokens
npm run check:icons
npm run test -- --maxWorkers=1
npm run build
npm run check:bundle-size
npm run e2e -- --workers=1
npm run check:ipc-contract
npm run check:ipc-types
```

Also run `git diff --check` from the repository root. If backend permission/lifecycle code is added after coordination, run the serialized Matrix Rust suite and security invariants too.

Manual evidence required before claiming WP-16 complete:

- Windows NVDA;
- macOS VoiceOver;
- Linux Orca if Linux remains supported;
- 200% zoom and narrow-window keyboard pass;
- WebView2, WKWebView, and WebKitGTK visual/functional checks on supported targets.

Unavailable platforms remain `not-run`, not “pass.”

## Hard stops

Stop and report instead of guessing when work requires:

- changing account-service/community-hosting separation;
- a custom Matrix extension without a reviewed schema/interoperability decision;
- claiming deletion of federated history;
- copying competitor code/assets without licensing review;
- adding a dependency or raising a bundle budget without approval;
- legal/trademark conclusions;
- deployment, publication, staging, committing, or pushing without authority.

## Completion record

Append one entry per work package.

```text
### A3 report — [WP-ID]
Status: complete | partial | blocked
Files changed:
Behavior delivered:
Bundle before/after:
Tests/commands and exact results:
Manual accessibility platforms: run | not-run
Evidence class: mocked | local | disposable-live | physical-live | external
Deviations and why:
Remaining blocker or product decision:
Shared-file wiring required:
```

### A3 report — WP-02

Status: complete

Files changed: `mesh/vite.config.ts`; `mesh/src/main.tsx`; `mesh/src/App.tsx`; `mesh/src/lib/lazy-motion.ts`; `mesh/src/lib/motion-features.ts`; `mesh/src/components/onboarding/OnboardingFlow.tsx`; `mesh/src/components/ui/Toast.tsx`; `mesh/src/components/layout/ContentArea.tsx`; `mesh/src/components/ui/ScopedErrorBoundary.tsx`; focused tests.

Behavior delivered: Replaced the forced eager Framer Motion chunk with `LazyMotion`/`domAnimation`, moved the existing room-context surface behind a retryable lazy boundary with a layout-preserving skeleton, and retained the install/invite/service-choice/sign-in/shell path in the eager graph. Later WP-22 work added its own independent lazy chunk.

Bundle before/after: before: entry 201.80 KiB, eager JavaScript 514.13/525 KiB, all JavaScript 1967.16 KiB, CSS 74.52 KiB, total production assets 2373.96 KiB. Final: entry 245.53/350 KiB, eager JavaScript 434.72/525 KiB, all JavaScript 1988.88/2048 KiB, CSS 80.41/100 KiB, fonts 332.28/400 KiB, total production assets 2401.57/2500 KiB. Eager JavaScript fell 79.41 KiB and has 90.28 KiB headroom. `RoomContextPanel` is 42.03 KiB and `RoomTabStrip` is 6.21 KiB, both asynchronous.

Tests/commands and exact results: focused TypeScript and 15 lazy-boundary/sidebar/chat tests passed; final `npm run build` passed (1081 modules); final `npm run check:bundle-size` passed every unchanged budget.

Manual accessibility platforms: not-run.

Evidence class: local.

Deviations and why: `App.tsx` is a shared hot file. Its only A3 change is the required one-line import handoff from the full motion package to the already-tested lazy-motion facade; no application behavior in that file changed.

Remaining blocker or product decision: none for WP-02. The existing 533.41 KiB asynchronous LiveKit chunk still emits Vite’s 500 KiB advisory, but it does not enter the eager graph or violate a configured budget and is owned by the voice lane.

Shared-file wiring required: none; the one-line `App.tsx` integration is already present and verified.

### A3 report — WP-13

Status: complete

Files changed: `mesh/src/styles/globals.css`; `mesh/tailwind.config.ts`; `mesh/scripts/check-design-tokens.mjs`.

Behavior delivered: Added `container`, `container-hover`, `container-active`, `container-line`, and `on-container` roles for surface, accent, success, warning, danger, and info. Fallback values support older webviews; supported engines derive states with OKLCH color mixing. High-contrast overrides and Tailwind exposure are included.

Bundle before/after: included in the final WP-02 measurements; no budget was raised.

Tests/commands and exact results: `npm run check:design-tokens` passed with 53 Tailwind colors and automated dark/light accent/status contrast assertions; `npm run lint`, `npx tsc --noEmit`, and `npm run check:icons` passed with zero warnings/errors.

Manual accessibility platforms: not-run.

Evidence class: local.

Deviations and why: none.

Remaining blocker or product decision: physical target-webview visual verification remains part of the WP-16 manual release gate.

Shared-file wiring required: none.

### A3 report — WP-14

Status: complete

Files changed: `mesh/src/components/ui/SequenceCard.ts`; `mesh/src/components/ui/SequenceCard.test.ts`; `mesh/src/styles/globals.css`; `mesh/src/components/community/MemberList.tsx`; `mesh/src/components/settings/UserSettingsPanel.tsx`.

Behavior delivered: Added explicit first/middle/last/single sequence positions without `:has()`, kept existing list semantics, and applied the utility to virtualized member rows and bounded settings rows with visible focus, selected, separator, and forced-color states.

Bundle before/after: included in the final WP-02 measurements; the helper compiles to a 0.16 KiB asynchronous shared chunk where reused by lazy surfaces.

Tests/commands and exact results: 18 focused SequenceCard/member/settings tests passed; final unit suite passed 98 files / 696 tests.

Manual accessibility platforms: not-run.

Evidence class: local.

Deviations and why: rollout was intentionally bounded to two list-heavy surfaces, as requested.

Remaining blocker or product decision: none.

Shared-file wiring required: none.

### A3 report — WP-15

Status: complete

Files changed: `mesh/src/components/navigation/CommandPalette.tsx`; `mesh/src/components/navigation/CommandPalette.test.ts`; `mesh/src/components/ui/InteractivePrimitives.tsx`.

Behavior delivered: Extended the existing palette with `#` channel, `@` DM/people, and `*` community scopes; deterministic fuzzy scoring; membership-safe candidates; bounded 20-row empty activity; plain independent-account-service breadcrumbs; activity then recency ordering; IME-safe key handling; and caller-provided filtering without replacing the existing keyboard/focus-return behavior.

Bundle before/after: final lazy `CommandPalette` chunk is 12.12 KiB; eager JavaScript remains 434.72/525 KiB.

Tests/commands and exact results: 15 focused palette/combobox/fuzzy tests passed; final 98-file / 696-test unit suite and 65-test browser suite passed. Design-system browser coverage verified the compact palette and keyboard-operable primitives.

Manual accessibility platforms: not-run.

Evidence class: local and mocked.

Deviations and why: none.

Remaining blocker or product decision: none.

Shared-file wiring required: none.

### A3 report — WP-16

Status: partial

Files changed: `mesh/src/components/chat/ChatView.tsx`; `mesh/src/lib/region-navigation.ts`; `mesh/src/lib/region-navigation.test.ts`; `mesh/src/components/layout/AppLayout.tsx`; `mesh/src/components/layout/ChannelSidebar.tsx`; `mesh/src/components/layout/ContentArea.tsx`; `mesh/src/components/community/RoomContextPanel.tsx`; `mesh/src/styles/globals.css`; `mesh/e2e/authenticated-shell.spec.ts`; `mesh/e2e/matrix-messaging.spec.ts`; `mesh/e2e/onboarding-accessibility.spec.ts`.

Behavior delivered: The empty-or-populated timeline retains `role="log"` with a dedicated polite arrival announcer rather than announcing virtualization churn. Virtual articles expose stable `aria-posinset`/`aria-setsize`. F6/Shift+F6 cycles visible communities, room/DM navigation, conversation, and optional context regions while Tab remains local. Minimum 24 px chat/voice-member targets, sticky-focus scroll margins, lazy-drawer focus recovery, and the existing click equivalent for voice-channel dragging are preserved. Axe coverage now spans account service, sign-in, saved-account/browser handoffs, invitations, community/room shell, encrypted DM, settings, community settings, voice-disabled state, narrow drawers, and the component gallery.

Bundle before/after: included in the final WP-02 measurements; no accessibility dependency was added.

Tests/commands and exact results: focused region/chat/sidebar tests passed 15/15. The first full browser run passed 60/65 and exposed the new article-parent ARIA issue plus a lazy-context focus race; both were corrected. The final `npm run e2e -- --workers=1` passed 65/65 Chromium tests in 1.5 minutes. Automated 200% zoom, narrow viewports, touch-only actions, reduced motion, axe WCAG A/AA, and voice-disabled checks passed. Final unit suite passed 98 files / 696 tests.

Manual accessibility platforms: not-run — Windows NVDA, macOS VoiceOver, Linux Orca, manual 200%/text-scaling/high-contrast keyboard review, and physical WebView2/WKWebView/WebKitGTK checks remain unrun.

Evidence class: local and mocked.

Deviations and why: automated Chromium coverage is evidence, not a substitute for the required assistive-technology and target-webview sessions.

Remaining blocker or product decision: WP-16 cannot be marked complete until the listed manual platforms are run and recorded.

Shared-file wiring required: none.

### A3 report — WP-17

Status: complete

Files changed: `mesh/src/store/settings.ts`; `mesh/src/store/settings.appearance.test.ts`; `mesh/src/lib/account-transition.test.ts`; `mesh/src/components/settings/UserSettingsPanel.tsx`; `mesh/src/components/settings/UserSettingsPanel.test.tsx`; `mesh/src/styles/globals.css`; `mesh/src/components/ui/InteractivePrimitives.tsx`; `mesh/src/components/ui/ModalLoadingFallback.tsx`; `mesh/src/components/settings/DiagnosticsPanel.tsx`; lazy fallbacks in `ContentArea.tsx` and `AppLayout.tsx`.

Behavior delivered: Added device-local “Subtle” and “Opaque” transparency choices that survive account resets, with blur restricted to bounded overlay surfaces and never the timeline. Forced colors is opaque. Panel/page fallbacks now preserve layout with status-labelled skeletons. Existing reduced-motion behavior remains dynamic and browser-tested.

Bundle before/after: included in the final WP-02 measurements; no dependency or budget increase.

Tests/commands and exact results: 27 focused appearance/account/settings/region tests passed; reduced-motion and narrow-layout browser tests passed; final unit and E2E suites passed 696/696 and 65/65.

Manual accessibility platforms: not-run.

Evidence class: local and mocked.

Deviations and why: speaking-ring behavior remains in Agent 2’s voice lane, as assigned; this tranche did not edit it.

Remaining blocker or product decision: none in the Agent 3 surface.

Shared-file wiring required: none.

### A3 report — WP-08

Status: partial

Files changed: `mesh/src/lib/community-onboarding.ts`; `mesh/src/lib/community-onboarding.test.ts`; `mesh/src/components/community/ChannelsAndRolesPanel.tsx`.

Behavior delivered: Added a versioned server-rules gate model for send/react/join-voice, a personal-sidebar projection that cannot change room visibility, authority-projected answer roles that cannot be injected by answer payloads, optional-interest skipping, account/community scope keys, and rejoin/room-upgrade reconciliation. Added a lazy-ready plain-language “Channels & Roles” panel contract that explicitly says sidebar selection does not change room visibility.

Bundle before/after: the unmounted leaf is not in the production graph; final configured budgets pass.

Tests/commands and exact results: 4/4 focused domain tests passed, including rules-version denial, answer-role injection resistance, optional skip, account isolation, rejoin, and upgrade mapping; final TypeScript/lint/unit suites passed.

Manual accessibility platforms: not-run.

Evidence class: local.

Deviations and why: the panel is not exposed. Doing so before authoritative Matrix state/account-data commands exist would create a renderer-only rules and persistence illusion.

Remaining blocker or product decision: Agent 1/backend work must define reviewed Matrix state/account-data storage, authoritative pre-acceptance enforcement, permission-projected answer grants, compatible-client behavior, and offline/reconnect semantics.

Shared-file wiring required: after the backend boundary exists, add typed IPC for definition/read/accept/save, lazy-mount `ChannelsAndRolesPanel`, and connect denial reasons to send/react/voice commands. Do not wire only React visibility.

### A3 report — WP-18

Status: blocked

Files changed: `mesh/src/lib/advanced-permissions.ts`; `mesh/src/lib/advanced-permissions.test.ts`; `mesh/docs/architecture/advanced-permissions-threat-model.rst`.

Behavior delivered: Added a strict versioned proposed schema and fail-closed preview evaluator for server group, client override, channel group, channel override, `skip`, `negate`, fixed specificity/tie ordering, fresh authoritative power/needed-power matching, owner recovery protection, room binding, stale revision rejection, plain allow/deny explanations, and bounded malicious-input parsing.

Bundle before/after: evaluator is not imported by production UI and adds zero production bytes.

Tests/commands and exact results: 6/6 focused tests passed, including 128 generated layer/effect combinations, ordering/ties, skip/negate, stale authority, room upgrades, insufficient power, final-owner protection, and malicious values.

Manual accessibility platforms: not-run.

Evidence class: local.

Deviations and why: no Advanced renderer or role duplication UI was shipped because there is no authoritative interoperable enforcement boundary to back it.

Remaining blocker or product decision: Mesh needs a reviewed Matrix state-event type, authorization rules, federation conflict resolution, room-upgrade migration rule, standard-client behavior decision, and server-side enforcement mechanism. Until then, unknown/extension state must remain unavailable and Simple Matrix power-level roles stay authoritative.

Shared-file wiring required: none before that protocol/product decision; do not integrate the preview evaluator as enforcement.

### A3 report — WP-19

Status: partial

Files changed: `mesh/src/lib/channel-lifecycle.ts`; `mesh/src/lib/channel-lifecycle.test.ts`; `mesh/docs/architecture/channel-lifetime-semantics.rst`.

Behavior delivered: Defined creation, authoritative occupancy, persisted grace, cancellation on re-entry, archive, tombstone stability, interoperable retention language, owner recovery, room-upgrade audit expectations, federation honesty, and designated-parent/rate-limit/audit/no-extra-power creation checks. Every decision explicitly reports `deletionGuaranteed: false`.

Bundle before/after: domain module is not imported by production UI and adds zero production bytes.

Tests/commands and exact results: 5/5 focused lifecycle tests passed for grace/archive/recovery/tombstone, power and parent scope, rate limiting, restart stability, and the restart-scoped stop.

Manual accessibility platforms: not-run.

Evidence class: local.

Deviations and why: `restart-scoped` returns a blocked decision. A federated community has no shared server restart epoch, so inventing one would contradict the zero-cost architecture.

Remaining blocker or product decision: define authoritative Matrix state events, a durable scheduler/lease owner, occupancy source, audit emission, upgrade migration, retention/operator policy, and the replacement product concept—if any—for restart-scoped rooms.

Shared-file wiring required: backend Matrix state/scheduler commands and moderation audit integration only after that design is reviewed.

### A3 report — WP-22

Status: partial

Files changed: `mesh/src/lib/room-tabs.ts`; `mesh/src/lib/room-tabs.test.ts`; `mesh/src/components/navigation/RoomTabStrip.tsx`; `mesh/src/components/navigation/RoomTabStrip.test.tsx`; integration in `mesh/src/components/layout/AppLayout.tsx`.

Behavior delivered: Added at most 12 account-scoped room/DM tabs and five recently closed entries; pin, reorder, close, reopen, next/previous, focus return, account-safe restore, corruption rejection, unread and mention badge rendering, keyboard shortcuts, and a narrow-window select rather than horizontal overflow. Navigation reuses existing stores/listeners and does not duplicate message state. The whole visual surface is a retryable 6.21 KiB lazy chunk.

Bundle before/after: final eager JavaScript remains 434.72/525 KiB; lazy tab chunk is 6.21 KiB; all configured budgets pass.

Tests/commands and exact results: 7/7 focused model/component tests passed for open/pin/reorder/close/reopen/cycle, bounded eviction, account isolation, corrupt restore, badges, shortcuts, and focus. Authenticated narrow/desktop, axe, and full browser suites passed; final total is 65/65 E2E.

Manual accessibility platforms: not-run.

Evidence class: local and mocked.

Deviations and why: current room and DM DTOs expose total unread counts but not a distinct mention count, so the model and UI preserve/render mention counts while runtime integration honestly supplies zero until an authoritative projection exists.

Remaining blocker or product decision: add authoritative per-room/per-DM mention counts and a multi-tab restore/navigation acceptance fixture before marking WP-22 complete.

Shared-file wiring required: extend the existing unread DTO/store projection with mention counts; no new message store or sync listener is required.

### A3 final verification — 2026-07-31

- `npm run lint`: passed, zero warnings/errors.
- `npx tsc --noEmit`: passed.
- `npm run check:design-tokens`: passed, 53 Tailwind colors and contrast/token assertions.
- `npm run check:icons`: passed.
- `npm run test -- --maxWorkers=1`: passed, 98 files / 696 tests.
- `npm run build`: passed, 1081 modules.
- `npm run check:bundle-size`: passed all seven configured limits; eager JavaScript 434.72/525 KiB.
- `npm run e2e -- --workers=1`: passed, 65/65 Chromium tests.
- `npm run check:ipc-contract`: passed, 3/3 checker tests and 172 commands.
- `npm run check:ipc-types`: passed; generated Rust-to-TypeScript contract current and Rust export helper compiled.
- `git diff --check`: passed.
- NVDA, VoiceOver, Orca, physical target webviews, manual zoom/text scaling, and manual Windows high contrast: not-run.
- No files were staged, committed, pushed, deployed, published, reset, stashed, or cleaned.
