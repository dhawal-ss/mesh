# Mesh competitive audit and production build plan

Prepared for the Mesh product owner and the next ChatGPT Sol implementation agent.

**Audit date:** 2026-07-30
**Repository baseline:** `main` at `72f093c` (`feat: complete Mesh UX and Matrix hardening`)
**Product constraint:** the recommended path must remain “install Mesh, open an invitation, choose or create an account, enter the community” without requiring protocol or infrastructure knowledge.
**Release constraint:** Matrix.org, community-hosted services, reviewed public services, and custom services remain explicit choices. An invitation may recommend community routing or account services but must never force the invitee’s account onto the community’s service.

## Executive summary

Mesh should not become a Discord visual clone with Matrix hidden underneath. Its winning position is a calm, consumer-quality community app that combines Discord’s social ergonomics, TeamSpeak and Mumble’s voice control, Element’s encryption and recovery maturity, Cinny’s restraint, and Matrix federation—without inheriting their complexity, lock-in, or infrastructure burden.

The current checkout is substantially stronger than the older readiness prompts imply. Local verification passed 616 frontend tests, 64 browser scenarios, 152 Matrix Rust tests, lint, build, IPC contracts, public-service checks, public-site checks, bundle budgets, and a high-severity npm audit. The live onboarding UI is polished, accessible, responsive, and unusually honest about independently operated services. Threads, pins, edits, replies, reactions, encrypted attachments, DMs, recovery, device review, notification controls, moderation actions, video controls, and screen sharing are already represented in the product or native boundary.

Mesh is **not production-ready yet**. The remaining critical path is no longer “build basic chat.” It is:

1. close the invitation-to-account loop across real public services;
2. prove native OAuth/session lifecycle against real providers;
3. prove encrypted MatrixRTC voice, video, screen sharing, TURN, revocation, and reconnect on live infrastructure;
4. ship a signed, publicly downloadable, recoverable Windows release with a safe updater;
5. prove federation, backup/restore, abuse controls, legal pages, and incident operations on the optional community-hosted service.

After those gates, the highest-leverage product work is personalized community onboarding, channel categories and forum-style rooms, representable roles and permissions, server-enforced moderation/AutoMod, scoped bots and webhooks, richer expression, and an SDK-backed room-list/timeline scale path.

## Decision

Build toward three release rings, in order:

| Ring | User promise | Exit condition |
|---|---|---|
| Controlled alpha | Invited testers can install, authenticate, join, message, recover, and report failures. | Signed test installer; one real public account service; two federated homeservers; recovery; content-free diagnostics. Voice may remain visibly unavailable. |
| Wider beta | The advertised Discord-alternative path works end to end, including trusted voice/video. | Live MatrixRTC E2EE/TURN/revocation matrix; clean-machine deep links; public canonical downloads; legal review; operator restore drill; invited beta metrics. |
| Production | Ordinary communities can rely on Mesh without the owner acting as live support. | Safe updater and rollback; incident/support runbooks; provider re-review cadence; abuse and moderation service; scale evidence; no unresolved P0/P1 security or accessibility defects. |

Do not market a local `NotSigned` bundle, a green unit suite, or a disabled capability as a production release.

## What was audited

### Repository and runtime

- Root product instructions, current production ledgers, prior Sol prompts, current Git history, workflows, package scripts, Tauri configuration, React surfaces, Rust Matrix boundary, MatrixRTC infrastructure, public-site artifacts, and browser acceptance coverage.
- Live Vite onboarding at desktop and the minimum supported `800×500` viewport.
- Service selection, reviewed public-service expansion, custom-service sign-in, public-service registration handoff, browser sign-in affordance, invitation context, and responsive accessibility.
- Current automated gates from the active `mesh/` application, not the older `meshcord/` tree.

### Competitor set

The review covers the products named in the request and the closest strategic archetypes:

- Discord
- Element and Element X
- Cinny
- Nheko (interpreting “nhuko” as Nheko)
- FluffyChat and Commet
- TeamSpeak 6
- Mumble
- Fluxer
- Stoat (formerly Revolt)
- Zulip
- Mattermost
- Slack

This is a decision-oriented market review, not a claim to enumerate every chat client.

## Current Mesh evidence

### Verified in this checkout

| Gate | Current result | Interpretation |
|---|---:|---|
| Frontend unit/component tests | 616 passed | Broad renderer and store behavior is covered. |
| Playwright browser scenarios | 64 passed | Includes cold-start invitation joining, accessibility, narrow layouts, encrypted messaging, and fail-closed voice behavior. |
| Matrix Rust tests | 152 passed | Includes OIDC callback safety, encrypted attachments, recovery boundaries, moderation guards, account removal/export, and MatrixRTC key/membership checks. |
| Lint and production build | Passed | The current TypeScript/React application builds successfully. |
| IPC contract | 171 commands passed | Renderer/native contract is checked and generated types are current. |
| Public services | Passed live | Matrix.org, tchncs.de, and quassel.io responded to discovery/version/login checks during this audit. |
| npm high-severity audit | 0 findings | This does not replace Rust, container, desktop, or runtime security review. |
| Bundle budget | Passed | Eager JS is within budget; total JS is close enough to the cap that new parity features need active code-splitting. |

### Present and worth preserving

- Explicit account-service choice with Matrix.org prominent but not silently selected.
- Reviewed public options plus a first-class custom-service route.
- Invitation context separated from account hosting.
- Plain-language trust, encryption, recovery, and device messaging.
- Communities, text channels, voice channels, encrypted DMs, replies, edits, reactions, pins, threads, search, typing state, receipts, notification modes, drafts, optimistic/durable send behavior, protected attachments, data export, account deactivation, and local account removal.
- Calm, coherent dark UI with theme, density, and accent choices; strong focus behavior; accessible modal/drawer patterns; touch-reachable message actions.
- Camera, screen-share, device selection, push-to-talk, input metering, peer volumes, and fail-closed MatrixRTC plumbing.
- Release workflow design for signed MSI/NSIS installers, checksums, CycloneDX SBOMs, GitHub provenance attestations, and reviewed draft prereleases.

### Present but deliberately gated

- Native browser OAuth is unavailable until provider/client configuration and complete session lifecycle are proven.
- MatrixRTC media stays unavailable until trusted SFU discovery, media E2EE, CSP endpoints, and live acceptance are proven.
- Public pages require explicit legal approval before deployment.
- Automatic updates are disabled until a signed endpoint, key, rollback behavior, and publication process exist.
- Community-hosted infrastructure is optional and has no uptime promise until an operator proves its runbooks.

### Concrete gaps found in the live product

1. **Third-party registration breaks the closed loop.** Matrix.org account creation currently opens Element’s web registration. Other reviewed services open their own web clients. The user must finish elsewhere and understand how to return to Mesh and resume the invitation.
2. **“Browser sign-in available” is not production evidence.** Browser builds correctly disable native callback behavior. A signed Tauri build still needs real provider registration, PKCE/state, restart, refresh, revocation, and logout validation.
3. **Profile pictures are read-only.** Users can change display names, but Mesh explicitly says profile pictures are currently read-only.
4. **Community structure is still text/voice-first.** Discord-style categories, forum channels, stage/audience rooms, scheduled events, and personalized room/role onboarding are not current first-class product concepts.
5. **Roles are intentionally narrow.** The current owner/admin/member model is safer than a fake permission system, but it does not provide Discord/TeamSpeak-level role composition, hierarchy, channel overrides, or effective-permission previews.
6. **Moderation is manual-first.** Kick, ban, report, role changes, and moderation audit behavior exist; timeouts, slow mode, join screening, raid response, server-enforced AutoMod, and appeals are not complete.
7. **Platform extensibility is absent.** No production bot/webhook/app permission model exists. This is a major retention gap versus Discord, Slack, Mattermost, Fluxer, and Zulip.
8. **Expression is narrower than the market.** Custom emoji exists, but stickers, GIF discovery, polls, voice notes, soundboards, and saved-media ergonomics are not at competitor depth.
9. **The current room-list/timeline architecture remains a scale risk.** The Rust dependency is `matrix-sdk 0.18`, but the application does not yet use the SDK’s higher-level UI services such as `matrix-sdk-ui`, `EventCache`, or `RoomListService`.
10. **Release status is owner/external-gated.** No current public signed release, published legal/invite site, live provider acceptance, live MatrixRTC deployment, or Mac-mini restore/federation drill was proven in this audit.

## Competitive research

### Discord: set the consumer interaction bar

Discord’s advantage is not a single feature. It is the continuity between invitation, personalized onboarding, channel discovery, everyday chat, drop-in voice, and community governance. Community Onboarding can assign roles and channels from questions; Server Guide supplies a welcome sign, starter tasks, and resource pages; forums organize persistent discussions with tags; stages distinguish audience, speakers, and moderators; AutoMod gives communities keyword, spam, mention, alert, and timeout controls; apps, bots, and activities make the server extensible.

**Borrow:** personalized onboarding, starter tasks, forum post organization, stage roles, obvious drop-in voice, scoped apps, and moderator automation.
**Reject:** centralized account/community lock-in, opaque trust guarantees, engagement-first noise, and features that pressure communities into paid infrastructure.

Sources: [Community Onboarding](https://support.discord.com/hc/en-us/articles/11074987197975-Community-Onboarding-FAQ), [Server Guide](https://support.discord.com/hc/en-us/articles/13497665141655-Server-Guide-FAQ), [Forum Channels](https://support.discord.com/hc/en-us/articles/6208479917079-Forum-Channels-FAQ), [Stage Channels](https://support.discord.com/hc/en-us/articles/1500005513722-Stage-Channels-FAQ), [AutoMod](https://discord.com/safety/auto-moderation-in-discord), [Discord apps](https://docs.discord.com/developers/quick-start/overview-of-apps), and [Discord’s beginner guide](https://support.discord.com/hc/en-us/articles/360045138571-Beginner-s-Guide-to-Discord).

### Element and Element X: set the Matrix trust and scale bar

Element demonstrates the mature Matrix path: encrypted rooms and calls, threads, spaces, files, recovery, device verification, cross-platform clients, and MatrixRTC. Element X also shows where the ecosystem is heading: native OAuth, sliding-sync-style room lists, Rust SDKs, and integrated MatrixRTC.

**Borrow:** crypto/recovery correctness, device trust, SDK-backed room/timeline services, OAuth lifecycle, interoperability, and live MatrixRTC architecture.
**Reject:** protocol-first copy, frequent technical interruptions, and a default experience that asks ordinary users to reason about homeservers or cryptographic internals.

Sources: [Element user guide](https://element.io/user-guide), [Element app](https://element.io/en/app), [Element encryption](https://element.io/features/end-to-end-encryption), [Matrix client catalog](https://matrix.org/ecosystem/clients/), [Matrix Rust SDK](https://github.com/matrix-org/matrix-rust-sdk), and [Matrix 2.0](https://matrix.org/blog/2024/10/29/matrix-2.0-is-here/).

### Cinny: set the calm-interface bar

Cinny makes a strong case for restraint: DMs are visually separated from channels, rooms are organized without Discord-like clutter, the composer adapts to context, and Matrix mechanics are mostly kept out of the everyday surface. Its current client profile includes E2EE, spaces, threads, OAuth, multi-account, emoji/image packs, and experimental MatrixRTC and simplified sliding sync. Its web client also demonstrates an in-client Matrix.org registration surface, even though provider-side registration constraints still apply.

**Borrow:** information hierarchy, visual calm, DM/community separation, progressive disclosure, and context-aware composition.
**Reject:** any design that assumes a web-only lifecycle or exposes experimental backend behavior as reliable.

Sources: [Cinny](https://cinny.in/), [Cinny Matrix profile](https://matrix.org/ecosystem/clients/cinny/), and [Cinny web registration](https://app.cinny.in/register/matrix.org).

### Nheko, FluffyChat, and Commet: learn from focused Matrix clients

Nheko is a compact native desktop client with E2EE, spaces, threads, OAuth, multiple accounts, and experimental MatrixRTC. FluffyChat’s recent recovery redesign emphasizes a user passphrase, downloadable key, automatic verification request, and less disruptive trust-on-first-use framing. Commet is notable for quick switching, account switching, search, screen-share quality work, private receipt/typing controls, and calendar/photo-album experiments.

**Borrow:** native responsiveness, recovery phrasing, account switching, quick navigation, and privacy controls.
**Reject:** beta-grade MatrixRTC claims without Mesh-specific live proof.

Sources: [Nheko profile](https://matrix.org/ecosystem/clients/nheko/), [FluffyChat recovery update](https://matrix.org/blog/2026/06/26/this-week-in-matrix-2026-06-26/), and [Commet update](https://matrix.org/blog/2026/03/06/this-week-in-matrix-2026-03-06/).

### TeamSpeak 6 and Mumble: set the serious-voice bar

TeamSpeak 6 emphasizes low-latency voice, high-quality screen sharing, self-hosting, server/channel groups, granular permissions, and community control. Mumble remains a reference for low-latency encrypted voice, positional audio, mic setup, low resource use, access control, overlays, and extensibility.

**Borrow:** device controls, mic test and calibration, connection diagnostics, low-latency tuning, positional/audio extensibility, speaker control, and explicit permission inspection.
**Reject:** TeamSpeak’s operator and permission jargon in the default path. Advanced voice and permission controls belong behind progressive disclosure.

Sources: [TeamSpeak 6](https://www.teamspeak.com/en/), [TeamSpeak getting started](https://www.teamspeak.com/en/support/get-started/), [TeamSpeak permissions](https://support.teamspeak.com/hc/en-us/articles/360002757557-Where-are-the-permissions), [Mumble](https://www.mumble.info/), and [Mumble positional audio](https://www.mumble.info/documentation/user/positional-audio/).

### Fluxer and Stoat: validate demand for an open Discord-like product

Fluxer presents a broad Discord-shaped surface: communities, categories, roles and permissions, threads, moderation and audit logs, bots and webhooks, search, custom expressions, voice/video/screen share, self-hosting, and localization. Its own roadmap still treats mobile and federation as major work. Stoat, formerly Revolt, now advertises video and screen sharing across voice, DMs, and group DMs, plus GIFs, slow mode, push notifications, and customization; its FAQ says federation is not on its roadmap.

**Borrow:** familiar community ergonomics, parity prioritization, expression, and open-source transparency.
**Reject:** treating self-hosting alone as decentralization. Mesh’s account portability and cross-service federation are the deeper advantage.

Sources: [Fluxer](https://fluxer.app/), [Fluxer source](https://github.com/fluxerapp/fluxer), [Stoat about](https://stoat.chat/about), [Stoat video release](https://stoat.chat/release-notes/93eb1f4ec77444ca9fb13617e0e6c0b1), and [Stoat developer FAQ](https://developers.stoat.chat/faq/).

### Zulip, Mattermost, and Slack: learn from organized work

Zulip’s topic-based threading proves that high-volume chat can remain readable. Mattermost demonstrates sovereign deployment, calls, playbooks, boards, bots, and workflow integration. Slack demonstrates the value of channels, huddles, searchable context, workflow tools, and a large integration ecosystem.

**Borrow:** topic organization, reliable search, workflow surfaces, integrations, and operational tooling.
**Reject:** turning Mesh into an enterprise work suite. Social communities and drop-in conversation stay primary.

Sources: [Zulip features](https://project.zulip.com/features/), [Zulip hosting](https://chat.zulip.com/help/zulip-cloud-or-self-hosting), [Mattermost platform](https://mattermost.com/platform-overview/), and [Slack features](https://app.slack.com/features).

## Competitive synthesis

| Product/archetype | Strongest lesson | Mesh advantage if executed | Immediate response |
|---|---|---|---|
| Discord | Seamless community onboarding and broad social feature depth | Federation, independent account choice, E2EE, and no required paid Mesh service | Close registration return, then add guided community onboarding and moderation depth. |
| Element | Matrix correctness, recovery, OAuth, MatrixRTC | Calmer consumer language and Discord-like community ergonomics | Follow SDK and protocol maturity; do not copy technical UX. |
| Cinny | Calm visual hierarchy | More complete moderation, voice, release, and community lifecycle | Preserve the current restrained shell and progressive disclosure. |
| Nheko/FluffyChat/Commet | Native speed, recovery, privacy, multi-account ideas | Unified desktop community product | Add account switching and adopt recovery/TOFU lessons after P0. |
| TeamSpeak/Mumble | Voice reliability and control | Voice integrated with encrypted federated communities | Treat live media acceptance and audio diagnostics as a release gate. |
| Fluxer/Stoat | Open Discord parity has visible demand | Actual cross-service federation and Matrix portability | Build parity selectively; lead with the decentralization experience, not protocol branding. |
| Zulip/Mattermost/Slack | Organization, search, apps, workflows | Social-first rather than enterprise-first | Add forum/topic modes and scoped integrations without suite sprawl. |

### The market opening

No reviewed competitor combines all four of these in one proven consumer product:

1. Discord-class community and voice ergonomics;
2. independent, federated account and community hosting;
3. end-to-end encrypted chat and media with credible recovery;
4. an open, zero-required-cost deployment model.

That combination is Mesh’s defensible target. It is also why the release gates matter more than another cosmetic parity feature.

## UX audit

### What feels production-caliber

- The two-column onboarding composition has a clear trust story and a focused service-choice task.
- Matrix.org is prominent without being preselected or described as Mesh-owned.
- Reviewed alternatives disclose operator, jurisdiction, limits, and independent-service status.
- “Use another service” is visible and accepts a full account ID or service address.
- Technical concepts are translated into “service,” “community,” “message backup,” and “browser sign-in.”
- The minimum supported viewport remains keyboard-reachable; the shell uses drawers and restores focus correctly.
- The main visual language is calm and coherent, closer to Cinny than to a noisy Discord clone.

### What prevents a seamless first run

The public-service creation CTA leaves Mesh. For Matrix.org it opens Element’s registration; for other providers it opens their web client or registration page. The product does not yet own the full return and invitation-resume experience. This is the most important UX seam because it appears at the exact moment a new invitee expects a one-app flow.

The correct fix is not to collect third-party credentials in an unsafe embedded webview. Mesh should:

1. discover whether the service supports OAuth account creation (`prompt=create`) or legacy registration;
2. launch the system browser with an opaque, expiring return transaction;
3. receive a verified loopback/deep-link callback when supported;
4. otherwise present a persistent “I created my account” continuation with the service and invitation preserved;
5. re-run service discovery, authenticate, and automatically resume the pending invitation;
6. show a plain recovery path when the provider blocks registration, uses CAPTCHA/UIAA, or requires email verification.

The Matrix specification now explicitly distinguishes legacy `/register` from OAuth account creation in the homeserver web UI, so provider-specific capability handling is unavoidable. See the [Matrix client-server authentication API](https://spec.matrix.org/v1.19/client-server-api/).

### Core-shell gaps to address after release gates

- Add editable avatars with protected upload, crop, content-type validation, removal, and cross-client refresh.
- Add community categories and a clear unread model across nested spaces.
- Add Discord-like personalized onboarding without binding the account to the community service.
- Add a forum presentation over Matrix rooms/threads before inventing a non-interoperable message store.
- Add a stage presentation over MatrixRTC only after normal calls are production-proven.
- Add better empty states, starter tasks, and “what to do next” guidance for new communities.
- Keep raw event IDs, room IDs, server names, TURN details, and crypto state in diagnostics/advanced settings only.

## Prioritized gap register

| Priority | Gap | User impact | Evidence required to close |
|---|---|---|---|
| P0 | Public-service account creation and return | Invitees leave the app and may never complete joining. | Real Matrix.org and one additional provider, clean account, cold-start invite, registration, callback/continuation, automatic join. |
| P0 | OAuth/session lifecycle | Browser sign-in cannot be promised safely. | Registered native client, PKCE/state, callback ownership, refresh/rotation, restart, logout, revoke, account removal. |
| P0 | MatrixRTC live media | Voice/video is a core Discord expectation but remains gated. | Two services, multiple networks/devices, E2EE, TURN-only, reconnect, screen share, key rotation, removal/revocation. |
| P0 | Signed public release | Ordinary users cannot safely install and update. | Valid timestamped signatures, canonical public downloads, provenance/SBOM verification, clean-machine deep links, rollback. |
| P0 | Federation/recovery/operations | Decentralization and durability are product promises. | Two-homeserver join and history recovery, backup restore, operator restore drill, rate/abuse controls, incident exercise. |
| P1 | Guided community onboarding | New users face an uncurated room list. | Rules, interests/roles, recommended rooms, starter tasks, mobile/narrow and accessibility acceptance. |
| P1 | Moderation automation | Larger communities cannot safely self-govern. | Timeouts, slow mode, join screening, raid controls, server-side AutoMod, appeals, tamper-evident audit. |
| P1 | Categories/forums/stage/events | Discord communities need more than text/voice rooms. | Interoperable state model, fallback in other Matrix clients, migration tests, accessible UI. |
| P1 | Roles and effective permissions | Owner/admin/member is too coarse. | Representable Matrix enforcement, effective-permission preview, channel overrides, escalation tests. |
| P1 | Bots/webhooks/apps | Communities cannot extend Mesh. | Scoped install manifest, room-specific grants, secret storage, revocation, audit, rate limits, sample integration. |
| P1 | Avatar and expression parity | Identity and culture feel unfinished. | Avatar edit/remove, GIF privacy policy, stickers, polls, voice notes, storage quotas. |
| P2 | SDK-backed room/timeline scale | Hand-rolled projection may fail at large account scale. | `matrix-sdk-ui`/EventCache/RoomList spike, benchmark, strangler migration, no recovery regressions. |
| P2 | Multi-account/mobile/i18n | Limits reach and account portability. | Account switch acceptance, mobile strategy, localization extraction, RTL and screen-reader gates. |

## Sol implementation plan

### Agent operating contract

The next agent must:

1. Read `AGENTS.md`, this plan, `PRODUCTION_BETA_PLAN.md`, and the current Git diff/status before editing.
2. Work in `D:\Creations\Applications\mesh` on `main`; completed Mesh work belongs on `main`.
3. Preserve unrelated user edits and generated artifacts. Do not reset, stage, commit, push, tag, release, deploy, mutate providers, or change live infrastructure unless the user explicitly authorizes it.
4. Treat the active application as `mesh/`; use `meshcord/` only as historical evidence unless a task explicitly targets it.
5. Re-check current behavior before implementing. Do not rebuild threads, pins, optimistic delivery, invitation confirmation, responsive panels, settings, or voice controls merely because an older plan calls them missing.
6. Keep account service, community routing service, and optional admission service separate in data models, code, and copy.
7. Keep OAuth and MatrixRTC visibly unavailable until their complete gates pass. Do not convert a local mock or unit test into a production capability claim.
8. Keep Matrix release builds free of `libp2p`; preserve the legacy backend only as an explicitly separate non-production feature.
9. Run Rust serialized on Windows and keep Vitest/Playwright workers bounded.
10. End every tranche with: changed files, named root cause, commands and results, verified behavior, remaining live/external blockers, and a clean distinction between code-complete and production-accepted.

### Phase 0 — freeze the truthful baseline

**Goal:** make this plan and the repository ledger agree before new feature work.

**Tasks**

- Update only the top current-status sections of `PRODUCTION_BETA_PLAN.md`; preserve clearly labeled historical snapshots.
- Add a machine-readable gate ledger such as `mesh/production-readiness.json` with `status`, `owner`, `evidence`, `lastVerifiedAt`, and `blocker`.
- Make release preflight reject a production capability set to `ready` without its required evidence identifiers.
- Record the audit baseline SHA and current test counts without making counts the release definition.

**Acceptance**

- The current ledger does not call already-landed UX work incomplete.
- Every P0 external gate has an owner and an evidence location.
- A stale or missing evidence reference fails preflight with an actionable message.

**Verify**

```powershell
cd D:\Creations\Applications\mesh\mesh
npm run release:preflight
npm test -- --maxWorkers=4
```

**Stop condition:** do not manufacture evidence for provider logins, signatures, live media, legal approval, or live infrastructure.

### Phase 1 — close public-service registration and invitation resume

**Goal:** a first-time invitee can leave for required provider UI and return without losing context or understanding Matrix.

**Likely areas**

- `mesh/src/components/onboarding/`
- `mesh/src/config/public-account-services.json`
- `mesh/src/lib/tauri.ts`
- `mesh/src-tauri/src/backend/matrix/oidc.rs`
- `mesh/src-tauri/src/backend/matrix.rs`
- `mesh/src-tauri/src/commands/`
- `mesh/src-tauri/src/main.rs`
- invitation/deep-link corpus and Playwright onboarding specs

**Implementation**

1. Extend service capability discovery to distinguish legacy registration, OAuth account creation, SSO-only, password login, external registration URL, and registration unavailable.
2. Create a native `RegistrationContinuation` transaction containing only bounded, non-secret service ID, invitation ID, start time, and opaque state.
3. Prefer OAuth authorization with `prompt=create` when supported and configured.
4. Otherwise open the provider’s reviewed HTTPS registration page in the system browser and keep Mesh on a persistent continuation screen.
5. Accept only the exact registered loopback path or validated `mesh://` callback; enforce state equality, expiry, one-time use, and single-listener ownership.
6. On return, re-discover the service, guide sign-in, restore the pending invitation, and join the community automatically.
7. Add plain outcomes for CAPTCHA/email verification, registration disabled, provider unavailable, invitation expired, and account created on a different service.
8. Never infer that the created account must use the community’s service.

**Acceptance**

- A cold-start `mesh://join` survives app restart and an external registration round trip.
- Matrix.org and one additional reviewed provider pass real owner-run acceptance.
- Cancelling or timing out leaves no listener, secret, or stuck pending state.
- The custom-service route remains first class.
- Browser and Tauri copy accurately reflects which steps can complete in that runtime.

**Tests**

- State mismatch, replay, expiry, occupied callback port, malicious callback path, multiple pending invitations, restart, provider failure, and invitation expiry.
- Playwright modeled flows plus owner-run signed-app evidence against real providers.

**Stop condition:** provider CAPTCHA, email, terms, or account policy is an external boundary. Do not bypass it or embed provider credentials.

### Phase 2 — production OAuth and account lifecycle

**Goal:** safe native authentication that survives normal desktop lifecycle events.

**Implementation**

- Register the actual Mesh native client with each supported provider or rely on standards-compliant dynamic registration only where the provider supports and permits it.
- Use authorization code with PKCE, high-entropy state, exact redirect matching, system browser, loopback callback ownership, and strict endpoint discovery.
- Persist refresh/access/session material only in the native secure store and Matrix SDK store; never expose tokens through renderer state or logs.
- Implement refresh rotation, invalid-grant recovery, offline start, restart during authorization, global logout, selected-device logout, provider revocation where supported, local account removal, and account deactivation reauthentication.
- Add saved-account switching without leaking full account IDs in casual UI.
- Re-run device/recovery bootstrap after a new OAuth device is created.

**Acceptance**

- Password, legacy SSO, and native OAuth accounts all have explicit, typed session kinds.
- Restart, sleep/wake, clock skew, expired access token, revoked refresh token, and provider logout have actionable outcomes.
- Account removal deletes exactly that account’s secrets, SDK store, cache, drafts, pending transfers, and continuation state while preserving other accounts.
- Logs and diagnostics contain no tokens, authorization codes, recovery keys, passwords, or local paths.

**Protocol basis:** [Matrix v1.19 authentication](https://spec.matrix.org/v1.19/client-server-api/) and [Matrix Authentication Service](https://github.com/element-hq/matrix-authentication-service).

**Stop condition:** do not enable the release flag until owner-run lifecycle evidence exists for every advertised provider path.

### Phase 3 — live MatrixRTC voice, video, and screen share

**Goal:** make “join voice” as obvious as Discord and as inspectable as TeamSpeak, while preserving Matrix E2EE and federation.

**Likely areas**

- `mesh/src/lib/livekit-voice.ts`
- `mesh/src/hooks/useVoiceEngine.ts`
- `mesh/src/components/voice/`
- `mesh/src-tauri/src/backend/matrix.rs`
- `mesh/infra/matrixrtc/`
- `mesh/scripts/matrixrtc-preflight.ps1`
- `mesh/scripts/probe-turn.ps1`

**Implementation**

1. Deploy the pinned MatrixRTC authorization service, LiveKit, TLS proxy, and TURN using reviewed secrets and DNS.
2. Discover RTC transport through the homeserver; never compile a universal Mesh SFU default.
3. Bind SFU authorization to Matrix room membership, current sync epoch, and exact configured endpoints.
4. Prove media E2EE key distribution, sender/device binding, rotation, replay rejection, pause/resume, reconnect, and late join.
5. Make kick/ban/leave/revoke invalidate publication and prevent removed members from decrypting new media.
6. Add pre-join mic/camera preview, mic test, input/output selection, noise/echo guidance, connection quality, relay status, per-user volume, and actionable diagnostics.
7. Test camera and screen-share transitions, system audio, multi-monitor selection where supported, screen-share privacy, and bandwidth degradation.
8. Keep emerging multi-SFU work behind compatibility discovery; do not advertise it before interoperable acceptance.

**Live acceptance matrix**

- Windows 10 and 11; at least two physical machines.
- Home NAT, mobile hotspot, restrictive network, relay-only TURN, and reconnect after network change.
- 1:1, 3-person, and larger invited call.
- Same-service and cross-service members.
- Audio-only, camera, screen share, concurrent camera/share, device switching, push-to-talk, deafen, and permission denied.
- Member kick/ban during active publication and key rotation after removal.

**Acceptance**

- No plaintext media reaches the SFU.
- A removed participant cannot decrypt media published after revocation.
- TURN-only calls work and diagnostics identify relay usage without exposing credentials.
- Failure copy gives a next action and keeps room/chat usable.
- Capability remains off when discovery, CSP, auth, E2EE, or freshness checks fail.

**Basis:** [MatrixRTC overview](https://matrix.org/blog/2024/10/29/matrix-2.0-is-here/), [2026 MatrixRTC transition](https://matrix.org/blog/2026/03/06/this-week-in-matrix-2026-03-06/), and [multi-SFU direction](https://matrix.org/blog/2026/06/19/this-week-in-matrix-2026-06-19/).

**Stop condition:** local fake-media tests and a green preflight do not satisfy this phase.

### Phase 4 — signed distribution, public trust, and updater

**Goal:** another person can safely download, install, open an invitation, verify provenance, and recover from a bad update.

**Implementation**

- Obtain and securely provision an Authenticode certificate; keep signing private material environment-scoped.
- Publish owner-reviewed legal, privacy, security, support, download, and invitation-fallback pages.
- Produce MSI and NSIS bundles with valid signatures and timestamps.
- Keep CycloneDX SBOMs, checksums, pinned actions, and GitHub provenance attestations.
- Add a canonical latest-download route that resolves to the reviewed release asset.
- Add clean-machine Windows acceptance for install/uninstall, WebView2 behavior, deep-link registration, invitation cold start, firewall prompts, and upgrade preservation.
- Only then add the Tauri updater with a separate update signing key, HTTPS endpoint, signature verification, staged rollout, downgrade protection, failure recovery, and rollback.
- Verify release assets and attestations after publication, not only inside CI.

**Acceptance**

- Public installers are signed, timestamped, checksumed, attested, and downloadable without repository access.
- `gh attestation verify` succeeds for released installers.
- The canonical download and invitation fallback work from a clean external network.
- Update failure does not corrupt accounts, encryption stores, drafts, or settings.
- Rollback has been exercised, not only documented.

**Basis:** [Tauri distribution](https://v2.tauri.app/distribute/), [Tauri Windows installers](https://v2.tauri.app/distribute/windows-installer/), and [GitHub artifact attestations](https://docs.github.com/en/enterprise-cloud@latest/actions/concepts/security/artifact-attestations).

**Stop condition:** no public `NotSigned` release and no updater without provisioned keys and rollback evidence.

### Phase 5 — federation, recovery, abuse, and operator acceptance

**Goal:** prove the decentralized promise and make optional community hosting operable without turning it into the user’s problem.

**Implementation**

- Run the reset federation/recovery suite, then repeat with two independently addressed live homeservers.
- Prove an account on service A joins a community on service B, goes offline, restores on a fresh device/store, and decrypts historical rooms/DMs, edits, replies, and attachments.
- Exercise signing-key backup, database/media backup, restore to replacement hardware, DNS continuity, and documented recovery time.
- Add rate limits, registration/admission policy, media quotas, retention/GC, abuse contacts, report handling, and security update cadence.
- Add content-free health metrics and incident signals without sending message content, room names, account IDs, or provider credentials.
- Document that optional Mac-mini/community hosting has no Mesh uptime SLA and never becomes a prerequisite for public-service users.

**Acceptance**

- Federation and clean-device recovery pass with retained evidence.
- Backup restore is timed and produces a usable service, not only restored files.
- Abuse, outage, signing-key compromise, disk pressure, and expired TLS drills have owners and actions.
- A community service can be removed or migrated without trapping members whose accounts are elsewhere.

**Stop condition:** live DNS, router, provider, and Mac-mini mutations require explicit owner authorization.

### Phase 6 — guided community onboarding and information architecture

**Goal:** match Discord’s “I know where to go” experience without sacrificing Matrix interoperability.

**Implementation**

- Add a community welcome surface with rules, description, safety notes, and 3–5 starter tasks.
- Let admins mark rooms as default, recommended, resource-only, or interest-linked.
- Add opt-in interest/role questions that affect the user’s visible/recommended room set, not account hosting.
- Model categories as nested Matrix spaces where possible; keep a graceful flat-room fallback.
- Show an honest completion state and allow onboarding to be revisited.
- Add a first-community creation wizard with safe defaults, sample rooms, moderation defaults, and invitation preview.

**Acceptance**

- A new invitee reaches a useful first room without scanning the entire community.
- Skipping personalization never blocks joining.
- Other Matrix clients still see the underlying spaces/rooms.
- Keyboard, screen reader, 200% zoom, `800×500`, reduced motion, and touch layouts pass.

### Phase 7 — roles, moderation, forums, and stages

**Goal:** give communities durable governance and richer conversation modes.

**Roles**

- Support named roles only when their effective security can be represented by Matrix power levels and room state.
- Provide an effective-permission inspector and preview before saving.
- Treat visual color/order as presentation metadata; never treat client-only metadata as authorization.
- Add constrained channel overrides with escalation and federation tests.

**Moderation**

- Add timeout/mute, unban, slow mode, join screening, raid mode, report queue, reason templates, appeals, and exportable moderation audit.
- Put reliable AutoMod in an optional community-hosted bot/admission service. Client-side filters may assist but are not enforcement.
- Give every automated action a bounded rule ID, actor, reason, target, appeal path, and reversible outcome where possible.

**Forums and stages**

- Project a forum room as root posts plus Matrix threads; add tags and sorting as interoperable state with a fallback view.
- Build stage/audience UI on production-proven MatrixRTC with explicit moderator/speaker/audience states and raise-hand behavior.
- Add scheduled events only after invitation, notification, timezone, and recurrence semantics are specified.

**Acceptance**

- Authorization is enforced by the native/server boundary, not only hidden buttons.
- A standard Matrix client retains readable room history and membership.
- Moderation and stage removal take effect during active sessions.
- Accessibility covers role editors, permission matrices, forum composition, and stage controls.

### Phase 8 — scoped bots, webhooks, and community apps

**Goal:** make Mesh extensible without recreating Discord’s broad bot-token risk.

**Implementation**

- Define a versioned app manifest: name, publisher, source, requested rooms, requested event scopes, outbound domains, commands, and data retention.
- Prefer Matrix application services/bot users for durable integrations and room-scoped webhooks for simple inbound/outbound automation.
- Keep secrets in the native/operator secure store; never return them to renderer state after creation.
- Add install review, least-privilege grants, per-room enablement, rate limits, audit, immediate revoke, secret rotation, and uninstall cleanup.
- Ship one reference webhook and one reference bot with tests and operator documentation.
- Add command discovery only for installed/allowed apps; keep arbitrary slash text as normal messages.

**Acceptance**

- A compromised app cannot read ungranted rooms or mint broader access.
- Every app event is attributable and revocable.
- E2EE rooms disclose when an integration requires a decrypting bot and require explicit informed consent.

### Phase 9 — identity, expression, and retention features

**Goal:** remove the remaining “beta” feel in everyday social use.

**Implementation order**

1. Editable profile and community avatars with crop/remove, safe media validation, cache invalidation, and cross-client refresh.
2. Polls represented as standard/extensible Matrix events where available.
3. Stickers and saved media with encrypted storage, quotas, and accessible alt text.
4. GIF search only after selecting a provider/privacy model; proxying must not silently make Mesh an operator or leak room/account context.
5. Voice messages with recording consent, preview, duration/size caps, waveform accessibility, and encrypted attachments.
6. Better link previews with SSRF-safe native fetching, allow/deny policy, privacy controls, and cache bounds.
7. Optional soundboard only after voice reliability; explicit per-user volume and mute.

**Acceptance**

- Every media type respects encryption, cancellation, quotas, content sniffing, filenames, export, deletion, and accessibility.
- Third-party expression services are disclosed and can be disabled.

### Phase 10 — SDK-backed scale and long-term platform

**Goal:** keep the current UX while reducing custom synchronization and timeline risk.

**Implementation**

- Write an ADR comparing the current projection with `matrix-sdk-ui`, `EventCache`, `Timeline`, and `RoomListService` in the pinned `matrix-sdk 0.18` toolchain.
- Build a read-only spike for one room list and one timeline behind a development flag.
- Benchmark cold start, initial sync, 10k-room account, large encrypted room, memory, pagination, edits/replies/threads, unread state, and recovery.
- Use a strangler migration with adapter contracts; never replace the entire shell in one tranche.
- Preserve the single crypto-store owner and serialized account lifecycle.
- Add multi-account switching after stores, background sync, notifications, and pending transfers have explicit per-account ownership.
- Extract localization keys and design an RTL/accessibility test plan.
- Decide mobile strategy only after the desktop beta proves retention and the shared native boundary is separable.

**Acceptance**

- The spike demonstrates measurable reliability or performance value.
- No loss of undecryptable placeholders, edits, replies, threads, reactions, pins, receipts, drafts, or recovery.
- The migration can be disabled without corrupting stores.

## Verification commands

Run sequentially on Windows unless a task explicitly has a narrower gate:

```powershell
cd D:\Creations\Applications\mesh\mesh

npm ci
npm run lint
npm run check:design-tokens
npm run check:icons
npm run check:ipc-contract
npm run check:generated-ipc
npm run check:public-services
npm run check:public-site
npm audit --audit-level=high
npm test -- --maxWorkers=4
npm run build
npm run check:bundle-size
npm run check:ipc-types
npm run e2e -- --workers=1

$env:CARGO_BUILD_JOBS = "1"
npm run test:rust:matrix
npm run test:rust:legacy
cargo clippy --manifest-path src-tauri\Cargo.toml --no-default-features --features matrix-backend --all-targets --locked --jobs 1 -- -D warnings

npm run setup:matrix-spike:reset
npm run test:matrix-spike
npm run matrixrtc:preflight
npm run operator:smoke
npm run release:preflight
```

Only run credentialed/live variants when the required external environment is intentionally provisioned. Capture provider, version, date, network/device matrix, and redacted evidence.

## Release stop conditions

The agent must stop and report rather than work around these boundaries:

- provider account, CAPTCHA, email, terms, or native-client registration is required;
- legal/privacy/support text needs owner or counsel approval;
- a signing certificate, update key, or protected release environment is missing;
- live DNS, TLS, router, Mac-mini, homeserver, SFU, TURN, or provider mutation is required;
- the requested role/permission cannot be enforced by Matrix/server state and would only hide UI;
- an E2EE integration would require a decrypting bot without explicit community consent;
- a test needs real people, physical devices, or independent networks;
- the worktree contains overlapping user changes that cannot be preserved safely.

## Definition of production-ready

Mesh is production-ready only when all of the following are true:

- A first-time invited user can install a signed build, create or sign in to an explicitly chosen service, return to Mesh, and join without protocol knowledge.
- Accounts hosted on one compatible service can join communities hosted on another.
- Encrypted room and DM history recovers on a genuinely fresh device/store.
- Voice, video, and screen sharing pass live E2EE, TURN, reconnect, and revocation acceptance—or the product clearly does not advertise them.
- Moderation, abuse response, backup/restore, incident handling, and support ownership are operational.
- Public downloads, signatures, checksums, SBOMs, attestations, legal pages, deep links, and updater rollback are verified from outside the developer machine.
- Accessibility and responsive acceptance pass on the release artifact.
- No release-critical capability is marked ready solely because a mock, local unit test, or static preflight passed.

## Further questions for the product owner

These do not block the first engineering tranche, but they change later sequencing:

1. Is Windows the only wider-beta platform, or must macOS/Linux ship in the same ring?
2. Which public services besides Matrix.org may be marketed as reviewed choices, and who owns the recurring policy review?
3. Is an optional community-hosted moderation/admission bot acceptable for server-enforced AutoMod?
4. Which integrations are essential for the first public communities: GitHub, YouTube/Twitch, RSS, calendar, or generic webhooks?
5. Is mobile a post-beta goal, or a production launch requirement?
6. What invited-beta community size and concurrency define acceptable scale?

## Caveats

- Competitor capabilities and policies change. The source links above were checked during this audit and should be re-reviewed before product claims or release decisions.
- Local tests prove the current checkout’s internal contracts, not public provider policy, real federation, physical audio behavior, code-signing trust, or operator readiness.
- Feature presence was assessed from current source and runtime surfaces. A UI affordance does not count as production capability when its native/live gate remains closed.
- The implementation plan intentionally prioritizes trust and completion of the core journey over raw checkbox parity.
