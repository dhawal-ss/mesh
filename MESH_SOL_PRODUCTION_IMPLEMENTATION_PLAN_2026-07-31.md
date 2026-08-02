# Mesh — Competitive Audit & Production Implementation Plan — For ChatGPT Sol

> **ARCHIVED 2026-07-31 PLAN.** Do not execute this file as a current handoff
> and do not reuse its production assertions. Current source, `AGENTS.md`, and
> the schema-v2 readiness ledger supersede it.

**Date:** 2026-07-31
**Branch:** `main`
**Integrated implementation SHA:** `7effb0cea2eba0b92aa4a62d749aad12ddbfdbbe`
**Current documentation SHA at distribution:** `b2427b6` (`main`, two local commits ahead of `origin/main`)
**Worktree state before this plan split:** clean. The prior three-agent WAVE2 implementation is already integrated on `main`; WP-00 and WP-01 below are closed and must not be repeated.

This document preserves the 2026-07-31 competitive audit and is now the master source for the next implementation wave. Together with the three `MESH_AGENT_*_2026-07-31.md` execution briefs, it supersedes the older one-off agent prompts and WAVE2 handoffs. `AGENTS.md` remains product law and `PRODUCTION_BETA_PLAN.md` remains the canonical verified readiness ledger.

---

## 1. Product North Star (unchanged, authoritative)

`AGENTS.md` is still the highest-authority document in this repo. Restated because it governs every priority call below:

> Mesh must feel like a regular consumer communication app, even though it is built on decentralized infrastructure. Install → open an invitation → sign in → enter the community — with no Matrix/homeserver/federation/TURN/relay concepts exposed on the default path.

Everything in this plan is subordinate to that rule and to the architecture guardrails in `AGENTS.md` (account service ≠ community hosting; no forced paid Mesh-operated homeserver; identity/membership/permissions/history stay on the Matrix control plane; peer storage is optional/bounded/reversible).

**New invariants this document adds, derived from the competitive audit (Section 4). Treat these as equally non-negotiable:**

1. **Ban vs. recovery must be wire- and UI-distinguishable.** A cryptographic ban (key rotation lockout) and a legitimate device-loss recovery must never produce the same signal to other members. If they look identical, users learn to ignore identity-change alerts and the ban mechanism stops working. (Section 4.2, Element's "Invisible Crypto" failure.)
2. **No AI feature runs off-device, and no AI acts autonomously on other users.** No agentic/tool-calling features with send permission. No AI moderation that can act on a decentralized network with no appeals authority. Mesh's moderation story is cryptographic bans enforced by math, not a classifier — this is a marketing and safety differentiator, not just a policy. (Discord's July 2026 AI-moderation-wrongfully-banned-thousands admission is the cautionary example.)
3. **Read receipts and typing indicators default OFF, reciprocal, per-conversation.** Silent delivery/presence signals let a peer be tracked online/offline with zero user interaction in a P2P topology — this is a security decision (see the "Careless Whisper" finding, Section 4.7), not a UX preference.
4. **Never put message content in an OS notification by default.** Plaintext leaks to notification center / lock screen / any mirroring service. Default text: "New message from `<name>`."
5. **Never expose a raw public key as identity.** Human handle + deterministic identicon derived from the key, always.
6. **Any drag interaction needs a non-drag equivalent; any interactive target must be ≥24×24 CSS px.** WCAG 2.2 AA (2.5.7, 2.5.8) is a hard release gate, not an aspiration — the EU Accessibility Act deadline has already passed (2025-06-28) and this is an unclaimed differentiator in this product category (Section 4.7).
7. **The trademark "Mesh" has not been cleared.** Revolt lost its name to a cease-and-desist mid-growth-spurt and it cost them their SEO/brand equity at the worst possible moment (Section 4.6). This is WP-23 and an owner-operated blocker in Section 12, not an engineering task—do not let engineering priorities bury it.

---

## 2. Instructions to you, the Sol implementation agent

1. **Read before writing.** Section 5 lists what is already done. Do not re-implement, re-review, or "clean up" any of it without a specific work package below telling you to.
2. **Preserve concurrent work.** The next three agents work in non-overlapping lanes defined by their briefs. Never reset, clean, switch branches, or overwrite another lane's files. If a shared hot file is needed, follow the ownership protocol in the brief.
3. **One work package, one report.** Append results to the assigned agent brief; do not create more handoff Markdown files. Stage, commit, push, deploy, or publish only when the user explicitly authorizes it.
4. **Every "done" claim requires the verification command in Section 10 to actually be run**, not assumed from a prior document. WP-00/WP-01 evidence is retained in `PRODUCTION_BETA_PLAN.md`; every new work package still needs fresh scoped verification.
5. **Competitive research citations in Section 4 are directional, not gospel.** A few 2026 Discord specifics (exact Boost bitrate ceilings) come from secondary sources per the research agent's own caveat — verify against Discord's live changelog before using any number in user-facing copy or marketing claims.
6. **Do not start new UI screens before the bundle-budget item in WP-02**—the integrated eager bundle is 514.13/525 KiB, only 10.87 KiB of headroom. Any new UI work package must include a lazy-loading plan for its own bundle cost.
7. **If a work package requires a product decision** (not an engineering judgment call), stop and flag it—do not guess. Section 12 lists the known owner-operated blockers.

---

## 3. Evidence hierarchy

1. Actual current source (`mesh/src`, `mesh/src-tauri`) — always wins over any doc.
2. `AGENTS.md` — product law.
3. `PRODUCTION_BETA_PLAN.md` — verified ledger and external-gate record. Do not re-litigate closed gates.
4. This document — competitive gap analysis and unified remaining-work plan.
5. `MESH_AGENT_1_SECURITY_PRIVACY_RECOVERY_2026-07-31.md`, `MESH_AGENT_2_VOICE_NETWORK_OPERATIONS_2026-07-31.md`, and `MESH_AGENT_3_PRODUCT_DESIGN_ACCESSIBILITY_2026-07-31.md` — current execution contracts and file ownership.

---

## 4. Competitive audit summary (full detail; condensed from a five-track research pass, ~90 sources, July 2026)

### 4.0 Market context — read this first

Discord announced global teen-by-default age verification (facial estimation or government ID) in February 2026, following a September 2025 vendor breach that leaked ~70,000 government ID photos submitted for age checks. "Discord alternatives" search volume spiked roughly 10,000% overnight. Discord postponed the rollout to H2 2026 after backlash, but user trust is damaged.

Every existing alternative failed to capture that moment: **Stoat** (Revolt's post-rebrand name, forced by a trademark cease-and-desist) had servers crash under load — its own status page read "There's simply too many people, but we're trying our best." **TeamSpeak 6** hit hosting capacity limits while still in beta, and is still blocked on the one feature Discord refugees actually want (persistent text chat independent of voice). **Element/Matrix** has the steepest learning curve of the group and no voice-channel model at all.

Matrix founder Matthew Hodgson said it plainly in February 2026: no Matrix client is a full drop-in Discord replacement yet, and "no other organisation stepped up" to build one. **That is a stated, dated market gap.** A new centralized entrant, Fluxer (launched January 2026, chat-first, federation planned), is rising on a pure familiarity pitch — it is not P2P and cannot make Mesh's core structural claim: a P2P architecture cannot get crushed by the traffic its own PR generates, which is exactly what killed Stoat's moment. This should anchor Mesh's go-to-market messaging once the product is actually ready, and it puts a soft clock on production readiness — the window opened by Discord's mistake will not stay open indefinitely.

### 4.1 Discord — what to copy, what to avoid

**Steal:**
- Persistent, click-to-join voice rooms with occupancy shown inline in the channel sidebar (no ring, no invite, no accept). This is the single most-copied Discord mechanic and, per Hodgson, nobody in the Matrix ecosystem has actually built it. For Mesh's P2P architecture this maps naturally onto a named topic/swarm peers subscribe to.
- Attach a text channel to every voice channel by default — cheap, eliminates "where do I paste the link."
- The onboarding pipeline: rules-acceptance gate blocks send/react/join-voice until accepted → admin-chosen default channels → interest/customization questions where each answer both grants a role and **adds channels to that specific member's sidebar** → a persistent, reversible "Channels & Roles" self-service tab. This interest-question-to-personal-sidebar mechanic is the highest-leverage, least-copied thing Discord has built.
- Forum channels as a first-class default channel type (post list is the channel view, tags, sort by activity) — Discord hides this behind a "Community" mode toggle, which is a mistake worth not repeating.
- Markdown-first composer with a selection-triggered floating format toolbar (no mode switch), and `/` as one unified command namespace.
- Beat Discord's own notification model: three-tier cascade (global → server → channel) plus **per-channel suppression of @everyone/@here/role pings** — a years-old Discord feature request that has never shipped.
- Rich live invite embeds showing community + channel + live occupant count + animated avatars. For a P2P app, "this room is alive right now" is the viral conversion mechanic.

**Avoid:**
- Threads with no unread indicator in primary navigation — Discord's own SVP has publicly conceded this is broken. Never ship a content container without an unread state in the nav.
- Big-bang redesigns with no opt-out or rollback window. Discord's March 2025 desktop redesign drew a rollback petition; a 2025 mobile redesign measured +2.7 seconds per action on the join-voice hot path and drew review-bombing. Rule for Mesh: ship behind a flag, never regress the click-count of a hot path.
- Electron-scale resource bloat — Discord's own admission (Dec 2025) that its Windows client can exceed 4GB RAM is Mesh's sharpest wedge as a Tauri app. Instrument and publish idle RSS from day one; make it a marketing number.
- Gating organizational primitives (forums, announcements, stages, rules) behind an opt-in "Community" toggle.
- Any in-surface attention economy (currency, shop, badges) — a decentralized encrypted competitor's core credibility rests on having zero incentive to do this.
- Settings sprawl / inconsistent iconography across screens — ship one searchable settings surface from v1.

### 4.2 Element (Matrix) — the closest cryptographic analog, and a two-year cautionary tale

Element's own "Invisible Crypto" initiative made things measurably worse over its first year by its own team's admission — more shields, more nags, more identity-change popups, more visible cryptography, not less. The fix (MSC4153) is to stop sending room keys to non-cross-signed devices at all rather than warning about them, on the stated principle that repeated warnings desensitize users. MSC4161 also had to standardize plain-language vocabulary after years of "backup password / security passphrase / recovery key" causing confusion even after five years of shipped UI.

The single sharpest, most avoidable failure mode: **users lose their one recovery key** because every other consumer service has trained them to expect an email-reset fallback, so they treat a 48-character generated key as low-risk and discard it. Losing it means losing all message history and triggering an identity-change alert for every contact — this is Element's own top-tracked usability bug.

Two more concrete, current gaps worth exploiting: Element's May 2026 "encrypted history sharing on invite" feature does not work when a user self-joins via a public link (keys can only come from an inviting member already in the room) — this is exactly the seam between "Discord-like open join" and "E2EE," and solving it for self-join is a real differentiator. And Element's room-list navigation went through a full ten-month round trip (filter chips → user revolt → sections again) — Mesh can skip the detour and ship persistent, drag-and-drop, per-space, state-preserving sections on day one.

**Steal:**
- Lock crypto vocabulary in a single source file before writing any UI string; use MSC4161's terms (digital identity, message key, message history, key storage, recovery key, device) verbatim. Mesh's structural advantage: with OS-keychain keys and no accounts, there is exactly one secret to explain, not two passwords — lead with that.
- Binary trust, no shields, ever — a device is either trusted or invisible to the crypto layer.
- Unlimited, equal devices; no "primary device" concept (Element's clearest win over Signal/WhatsApp/Wire).
- Recovery key delivery into the OS keychain / password manager, not a downloadable text file — Element has stated this as an unshipped next step; ship it first, with checksum validation and a recurring "does this key actually work" health check.
- Back up the cryptographic identity itself (encrypted under the recovery key), not just message keys, so device loss does not force an identity reset. **This directly interacts with Mesh's key-rotation ban mechanism — see invariant #1 in Section 1.**
- Encrypted history sharing on invite, but solved for self-join too, not just invited-member join.
- MatrixRTC's "Slots" concept (moderator-managed, multiple meeting containers per room) is exactly the right primitive for persistent voice channels and nobody has exposed it as one yet.

**Avoid:**
- Any unresolvable error state. Every crypto error must name the cause, name the fix, and offer a button that performs it.
- Rendering an undecryptable message as permanent dead text with no retry/reason/request-key action.
- Stripping diagnostic detail in the name of simplicity — ship an "Advanced"/debug drawer instead of removing information power users need, since Mesh has no second power-user client to fall back on the way Matrix does.
- Delegating identity/device management to an embedded browser/webview.
- Per-room-only moderation scope — Matrix cannot ban across a space at the protocol level. Design Mesh's ban/moderation scope object explicitly (community-level, propagates to every channel, survives rejoin, auditable) rather than inheriting Matrix's limitation by default.

### 4.3 Cinny — the visual design benchmark; already Mesh's own stated reference in `AGENTS.md`

Cinny is a Tauri v2 desktop app itself, React + TypeScript, with its own design-token package ("Folds") built on a small, disciplined token set: 5 type scales, 8 spacing steps, 5 border-radii, 4 shadow elevations, and — the key idea — every color role is a five-value "container quintuple" (Container / ContainerHover / ContainerActive / ContainerLine / OnContainer) so no individual component ever invents its own hover color. This is why all four of Cinny's shipped themes look equally finished, and it is the direct, buildable answer to the project instruction "always have a modern approach to design that will rival Discord."

Specific, literally reusable patterns: a "SequenceCard" CSS technique (`:not(&) + &` / `&:not(:has(+&))` selectors) that fuses consecutive list rows into one rounded card in ~30 lines of CSS, instantly making settings/member-list screens look designed instead of assembled; a command palette with sigil-scoped search (`#` rooms, `*` spaces, `@` DMs) that shows the top 20 recently-active items before the user types anything, with breadcrumb context on every row; and micro-interactions — a 3px×24px active-state pill that animates height (not opacity) over 200ms, a 2px hover translateX on list items, a 2px hover translateY lift on avatars — that account for most of the "this feels modern" perception at almost no engineering cost.

**Steal:** the container-quintuple color token model; SequenceCard; the sigil-scoped command palette; the exact micro-interaction timings above; density as a genuine user setting (layout × spacing, not a fixed opinion), including a low-cost warm-toned dark theme ("Butter" in Cinny) as a cheap differentiator.

**Avoid:** shipping a thread *button* with no actual thread panel (Cinny has had this gap since August 2025 — comparison tables mark it done when the experience is a decorated reply); emoji-only SAS device verification with no QR fallback; theming that requires a browser extension to customize (Cinny's own answer for its web client is "use a userstyle extension," which is not available to a packaged Tauri desktop app — Mesh must ship a native user-theme loader).

### 4.4 Nheko — the native/lightweight cautionary tale

Nheko is functionally stalled (last substantive release ~12 months ago as of this audit, 548 open issues, still on the deprecated `libolm` crypto library with a published CVE nearly two years after Matrix deprecated it). Its community fork, Komai, replaced the crypto stack with `matrix-rust-sdk` in days using modern tooling — the exact migration Nheko's maintainers avoided for two years — and immediately looked more credible as a security-sensitive client. The lesson for Mesh: a security-critical dependency cannot be allowed to go stale, ever, regardless of how good the native performance story is.

Nheko/Komai do have real, cheap UX wins worth lifting directly: browser-style room tabs (open multiple conversations side-by-side, pinned, restored on relaunch — Discord has no equivalent, this would be a genuine differentiator, not parity); both sidebars collapsible to icon-only rather than Discord's binary show/hide; emoji-SAS verification that labels each emoji with its name and a reject button that says "They do not match!" instead of "Cancel"; timeline gap markers ("N hours later") and fully local, client-side search over decrypted history (the only search model that survives E2EE without a server-side plaintext index).

**Steal:** browser-style pinned room tabs; dual collapsible-to-icon sidebars; named-emoji SAS verification with an explicit mismatch action; timeline gap markers; local encrypted search; treating performance/resource-usage improvements as a named, user-visible changelog category.

**Avoid:** letting the crypto library or any security-critical dependency go stale — this should be a CI-enforced gate, not a backlog item; OS-native-palette theming instead of a real token system (this is the entire visual gap between Nheko and Cinny); configuration via modal dialogs instead of an in-app settings surface with live preview.

### 4.5 TeamSpeak (incl. TS6) — still winning on voice engineering and permissions, still losing on everything else

TeamSpeak's voice quality edge over Discord is concrete and specific: roughly 20-40ms latency versus Discord's 50-100ms because it's a purpose-built voice protocol, not a general RTC stack also carrying video and screenshare; a two-profile Opus codec model (a "Voice" profile capped around 45kbps and a "Music" profile that can go to ~79-97kbps) exposed as a simple quality dial, versus Discord's flat 64kbps free-tier ceiling; and no server-side transcoding, so bandwidth is a clean, publishable formula (`users × bitrate × 1.25`) — which is a strong marketing number for a P2P app with zero SFU transcoding by default.

Its permission model is the most sophisticated in the category and directly solves a problem Discord's flat role hierarchy cannot express at all: a four-tier resolver (Server Groups → client-specific overrides → Channel Groups → channel-specific) with `skip` (a grant that cannot be overridden by a lower-priority tier) and `negate` (inverts to lowest-wins, enabling additive "punishment" groups layered on top of existing roles without stripping them) flags, plus a "power vs. needed-power" antisymmetric check per moderation action so a junior moderator with ban-power 50 cannot touch a senior moderator whose needed-ban-power is 100, while the senior can still act on the junior. It also supports three channel lifetimes (permanent / semi-permanent / temporary-auto-delete-when-empty) — granting ordinary members the right to create only *temporary* child channels under a "Create Room" parent lets a community self-organize ad hoc voice rooms with zero admin cleanup, something Discord has no equivalent for.

TeamSpeak's own community forum (February 2026) is effectively a free requirements document for what's currently killing its Discord-refugee moment: its #1 complaint by far is that text chat requires being inside a voice channel — "modern communities don't separate voice and chat anymore... they are the backbone" — and TeamSpeak's own staff response was "not if, but when," with no shipped date after having previously tried and abandoned a Matrix-based implementation as "not reliable and stable enough." Its #2 complaint is that its powerful permission engine has no approachable UI (a Discord-fluent admin could not figure out how to create a simple subscriber role, and there is no way to duplicate an existing permission group). Its #3 complaint is IP-address-based onboarding rather than invite links. It also still requires a TeamSpeak account even in its from-scratch TS6 beta, which undercuts its own sovereignty pitch, and has no mobile client after 18 months of beta.

**Steal:** the two-profile Opus model with FEC and per-channel quality dial, published as a plain bandwidth formula; the full four-tier permission resolver with `skip`/`negate` and power/needed-power pairs, but hidden behind a Simple/Advanced toggle by default (TeamSpeak's failure here is entirely a missing-UI problem on top of a good engine); three channel lifetimes with member-grantable "create temporary channel"; Priority Speaker (client-side gain ducking, near-zero cost) and Whisper Lists (choosing which peer connections receive audio frames — trivially cheap in a P2P mesh, arguably cheaper for Mesh than for TeamSpeak's client-server model) as differentiators nobody else in the category has.

**Avoid:** ever coupling text-channel access to voice-channel presence — this is architecturally the reason Mesh needs offline-capable message sync (CRDT/log-replay) designed in from the start, not retrofitted; IP-address-based onboarding instead of cryptographic invite links; exposing raw permission IDs as the default admin surface instead of role templates plus role duplication; requiring any account for the sovereignty-focused product tier; bundling heavy optional subsystems into the default self-hosted build.

### 4.6 Stoat (formerly Revolt) and Signal

**Stoat** is the direct cautionary tale for what happens when a centralized "Discord clone" architecture meets a sudden traffic surge: it crashed under its own PR moment in February 2026, its "minimal" self-host is still six containers and its full stack around fifteen (one reviewer abandoned self-hosting it before even trying Mesh-style alternatives), its voice has no noise suppression or echo cancellation, and — most relevant to Mesh specifically — it lost its original brand name ("Revolt") to a trademark cease-and-desist in the middle of its highest-growth window, destroying accumulated SEO and brand equity overnight. **Mesh has not cleared "Mesh" as a trademark; this is flagged as a legal blocker in Section 15, directly motivated by this exact failure mode.**

Mesh's honest structural marketing claim writes itself here: a P2P architecture cannot be crushed by the traffic its own PR generates, which is precisely what happened to Stoat. That claim is only usable once the product actually works end-to-end, including under load—do not ship this messaging before the live/manual matrix in Section 11 is green.

**Signal** offers the best-documented arc for how to make end-to-end encryption invisible without lying about it: it renamed "fingerprint" to "safety number" after research showed "fingerprint" reads as biometric/police surveillance; moved from hex to twelve groups of five decimal digits (shorter, and decimal exists in every written language, unlike hex); made verification per-conversation instead of per-contact-pair to eliminate a confusing four-hex-string/two-QR-code flow; ships identity/key changes as an inline advisory notice rather than a blocking warning, on the theory that users want to *know*, not be *stopped*; and its 2025-2026 "Secure Backups" feature (a single 64-character on-device recovery key that even Signal cannot recover or bypass) rolled out over five full months specifically because staged rollout of anything touching a user's only recovery path is safer than a big-bang launch. Signal's mandatory numeric-discriminator usernames (`name.42`) that are never shown to contacts and are freely changeable is also a clean anti-impersonation, anti-squatting pattern worth copying directly for Mesh's human-readable handles.

**Steal:** per-conversation, decimal, single-QR safety-number verification with disciplined plain-language naming (never "fingerprint," "hash," or "public key" in user-facing copy); advisory (non-blocking) treatment of identity/key changes as the default; a single generated recovery key with a forced verification step at creation and a real recurring health check, following Signal's own view-once/24-hour-message backup exclusion rules; QR-based device linking with a bounded history-sync window; numeric-discriminator usernames with a "name not verified" label on unverified display names.

**Avoid:** phone-number-rooted identity (disqualifying for Mesh's target audience — stay keypair-rooted, as Mesh already is); treating backup/recovery as a post-launch feature — for a P2P app, device loss is the #1 predictable churn event and must ship in v1, not six years later as it did for Signal.

### 4.7 2025-2026 cross-cutting design and accessibility findings

Glassmorphism/"Liquid Glass" style UI peaked and was publicly walked back by its own creator (Apple shipped an opacity slider and a "Tinted" toggle within a year of launching it, after usability teardowns showed real legibility failures, e.g. text over user images becoming unreadable). The better-evidenced 2025 alternative is Google's Material 3 Expressive system (46 studies, 18,000+ participants; expressive visual treatments measurably help users locate key UI up to 4x faster) built on OKLCH color (perceptually uniform, ~87% browser support mid-2026, lets a whole theme's interaction states be generated algorithmically instead of hand-picked) and spring-physics motion instead of duration/easing curves.

The single most important accessibility/privacy finding for a P2P chat app specifically is the "Careless Whisper" research result: *silent* delivery/read receipts and presence signals let an attacker passively track when a user is online, infer activity patterns, and drain their battery, with zero interaction from the victim. In a P2P topology this leak is direct peer-to-peer, not mediated by a server that could at least rate-limit it — which is why invariant #3 in Section 1 treats receipts/typing-indicators-off-by-default as a security decision, not a preference toggle.

On accessibility specifically: WCAG 2.2 became mandatory in the EU on 2025-06-28 under the European Accessibility Act (penalties up to €100,000 or 4% of revenue), and the four success criteria most likely to be violated by a chat app are Focus Not Obscured (sticky headers/hover toolbars covering the focused element), Dragging Movements (every drag interaction needs a non-drag equivalent), Target Size (24×24 CSS px minimum — reaction chips and hover-only action buttons are the usual violators), and Accessible Authentication (asking a user to transcribe a key fingerprint from memory is a cognitive-function test and fails AA outright — copy/paste, QR, and file-based flows must always be available). No competitor in this category has fully solved this; it is a genuinely open differentiator, not just compliance overhead.

**Steal:** a real transparency slider (default ~0.85 opacity) rather than a glass aesthetic, backdrop-blur capped at 8-12px and only on small non-scrolling surfaces (never the message list); OKLCH-based tokens with `light-dark()`; `role="log"` with implicit `aria-live="polite"` on the message list, present and empty at mount; Slack's keyboard model (`F6` between regions, `Tab` within, arrow-key entry from an empty composer) plus roving tabindex and `aria-setsize`/`aria-posinset` on virtualized message rows; skeleton loading states instead of spinners (tolerated ~40% longer by users) with a ≤400ms-to-painted-chrome, ≤2s-to-interactive budget that explicitly accounts for SQLCipher key derivation and any P2P bootstrap not blocking first paint; local, on-device live captions as the one AI feature that is unambiguously safe for an E2E product.

**Avoid:** any adaptive/self-rearranging UI chrome; motion applied without specific meaning (users see the same transition hundreds of times per session in a chat app — budget motion far more conservatively than a marketing site would); relying on `prefers-reduced-transparency` as anything but a default-setter (it's non-Baseline and flagged as a fingerprinting vector); `content-visibility: auto` on a reverse-scrolling message list (causes scrollbar jump); assuming any AI feature is safe to ship with network access or autonomous action — Signal's own president has publicly identified prompt injection as the most likely first real-world exploit path against encrypted messengers, which is a direct argument against any agentic AI feature with send permission in Mesh.

---

## 5. Current verified baseline — DO NOT REBUILD

Confirmed on integrated source SHA `7effb0cea2eba0b92aa4a62d749aad12ddbfdbbe`; the documentation update is `b2427b6`.

**Closed and merged (`PRODUCTION_BETA_PLAN.md` Z0-Z8 ledger):** service-choice independence, account-independent invitations v5, optional/BYOH community hosting with no SLA, zero-cost static-site distribution, identity/session/recovery separation, voice framed as a detected capability rather than a promise, and wider-beta hardening. At closure: 555/555 Vitest, 64/64 Playwright, 146 Matrix + 221 legacy Rust tests, all bundle/design-token/icon/IPC-contract checks green (self-reported at merge time — re-verify per WP-01).

**Done and integrated on `main`:**
- **Identity/Onboarding (Agent 1):** issuer-keyed `OidcClientRegistry` replacing a single global OAuth client ID that allowed cross-provider credential confusion (`mesh/src-tauri/src/backend/matrix/oidc/configuration.rs`); registration-continuation state now only consumed after successful auth, not on screen transition.
- **Realtime/Release/Operations (Agent 2):** MatrixRTC/LiveKit client wiring; a bounded (20s/12-attempt) federation test harness replacing a ~45-minute worst-case unbounded poll; a real presence-publication bug fix (Matrix SDK 0.18 silently omits `set_presence=online` on offline→online transitions when it matches the default — now explicit, with rollback on failure); a schema-v2 tamper-evident RTC evidence validator (15/15 tests passing); a hardened `release-beta.yml` with SBOM, provenance, and proof that `libp2p`/`ring`/`hickory-proto`/`rustls-webpki` are absent from the Matrix release build's dependency tree.
- **Community Platform (Agent 3):** real per-room Matrix power-level projection (`mesh/src-tauri/src/backend/matrix/moderation/permission_projection.rs`) replacing a fake "template equals current state" role UI; `RolePermissionPreview.tsx` now distinguishes template vs. current vs. proposed vs. unknown state; `MemberList.tsx` blocks "Apply" until the authoritative projection loads; power-level writes now have pre/post recovery-path checks so a moderator cannot accidentally leave a room unrecoverable.

**The shared backend trait, Tauri command, generated IPC contract, renderer bridge, permission-state event, and account-scoped settings invalidation are also integrated.** The final serialized gate passed 91 Vitest files / 648 tests, 64 Playwright scenarios, 164 Matrix library tests plus contracts/helpers, 203 legacy library tests plus contracts/integration tests, security invariants, build/bundle/design/icon/IPC checks, and two clean-source federation/recovery cycles. See `PRODUCTION_BETA_PLAN.md` for exact evidence and external gates.

**Confirmed still-open, low-priority, and scoped to the frozen `legacy-p2p` Cargo feature (not the default `matrix-backend` build):**
- `default_relay_nodes()` defined, zero call sites (`mesh/src-tauri/src/network/discovery.rs:60`).
- `blocking_read()` in async contexts, 3 call sites (`mesh/src-tauri/src/app_runtime/network_router.rs:570,692,728`) plus 1 (`mesh/src-tauri/src/app_runtime/message_handler.rs:108`).
- DB errors silently discarded in `insert_message_if_new` (`mesh/src-tauri/src/app_runtime/helpers.rs:5-12`, `let _ = db.insert_message(message);`).
- 5 unresolved `cargo audit` RUSTSEC advisories in the legacy libp2p dependency tree, confirmed absent from the Matrix release build.

**Confirmed fixed (do not re-fix):** invite join response spoofing — the wrapped group key is now bound to the joiner's own signed X25519 key (`mesh/src-tauri/src/app_runtime/invite_handler.rs:390-655`); key-rotation replay for existing members (`mesh/src-tauri/src/crypto/key_rotation.rs:145-153`); the inverted voice-leave logic (`mesh/src-tauri/src/state/voice_state.rs:352-384`, 8 dedicated tests passing).

---

## 6. The single most important finding in this audit: **voice does not currently work at all, end-to-end**

This is not "voice is buggy" or "voice needs polish." Confirm this yourself before planning around any other assumption:

- The **new** MatrixRTC/LiveKit voice path is deliberately, explicitly gated off (`VoiceServiceAvailability::ClientUnavailable`, `BackendCapabilities.voice == false`, `media_e2ee_verified` hard-pinned `false`) pending real TURN/SFU infrastructure. All 23 items in Agent 2's physical/network acceptance matrix (NAT traversal, kick/ban mid-call, restart mid-call, key rotation on late join, etc.) are `not-run`.
- The **legacy** simple-peer voice path — the only voice implementation actually reachable from the UI today — has three confirmed, still-present bugs: `AudioContext` is never recreated after entering the `'closed'` state (`mesh/src/lib/voice-engine.ts:842-849`); `MediaStream` tracks are never stopped on relay-peer disconnect, a real leak (`mesh/src/lib/voice-engine.ts:587-640`); and it depends on a private, undocumented `SimplePeer.negotiate()` API at two call sites (`mesh/src/lib/voice-engine.ts:533,556`). No TURN server is configured or deployed anywhere in the repo (`mesh/infra/` has homeserver and MatrixRTC-evidence tooling only, no TURN/coturn config).

**Treat "ship one working voice path" as the top functional priority in this plan, above any new competitive feature.** Section 4.1 and 4.5's voice-UX findings (persistent rooms, Opus profiles, Priority Speaker) are worthless to plan against until one voice path is real. WP-04 through WP-07 sequence this explicitly.

---

## 7. Ordered implementation phases

**Phase A — Close the loop (unblocks everything else).** WP-00, WP-01.
**Phase B — Make voice real.** WP-02 through WP-05.
**Phase C — Close the P0 competitive gaps that block calling this "production-ready" as a Discord alternative.** WP-06 through WP-12.
**Phase D — Design-system and accessibility pass (the "rival Discord in form" mandate).** WP-13 through WP-17.
**Phase E — P1 differentiators (competitive advantages, not parity).** WP-18 through WP-22.
**Phase F — Legal, ops, and release hardening.** WP-23 through WP-26.

Do not start a later phase's work packages before the prior phase's blocking items are verified green, except where a work package explicitly says it can run in parallel.

---

## 8. Detailed work packages

### WP-00 — Close the three-way WAVE2 integration barrier — COMPLETE
**Phase A. Closed on `7effb0c`; do not repeat.**
The dirty worktree contains three independently-completed workstreams that all touch shared surface (backend capability trait, IPC commands, settings store). Merge them onto one clean SHA:
1. Land Agent 1's `OidcClientRegistry` and registration-continuation fix.
2. Land Agent 2's MatrixRTC wiring, bounded federation harness, presence fix, RTC evidence validator, and hardened release workflow.
3. Land Agent 3's `permission_projection.rs`, `RolePermissionPreview.tsx`, and `MemberList.tsx` changes.
4. Implement the specific integration point Agent 3's handoff requests from the barrier owner: a new `MeshBackend::community_permission_projection` trait method, a new Tauri command `matrix_get_community_permission_projection`, IPC type regeneration, the corresponding bridge method in `mesh/src/lib/bridge.ts`, and a new `MatrixPermissionStateChanged` event.
5. Implement Agent 1's explicit 8-point spec for an account-scoped reset/invalidation API in `mesh/src/store/settings.ts` — currently an in-flight fetch/save from the previously-active account can repopulate state after switching accounts. This is a real, specified race condition, not speculative.
6. Run the full verification matrix (Section 10) on the merged result before any other work package starts.
7. Delete the two leftover Windows temp test directories (`.tmpfowK72`, `.tmp1FFWCq`) as part of this cleanup pass.

### WP-01 — Re-verify the baseline, don't trust it — COMPLETE
**Phase A. Closed on `7effb0c`, with the clean evidence ledgered by `b2427b6`; do not repeat.**
Re-run `npm run test`, `npm run e2e`, `cargo test` (both feature sets), `check:design-tokens`, and the IPC contract check fresh on the merged WP-00 SHA. Clear or explain the 14 stale Playwright failure-artifact directories in `mesh/test-results/` — either they're pre-WP-00 noise (delete) or they represent real current failures (fix before proceeding). Do not carry forward any "555/555" or "64/64" claim from a prior doc without a fresh run producing that exact number on the current SHA.

### WP-02 — Bundle budget triage before any new UI work
**Phase B (parallel-safe with WP-00/01).**
Eager JS bundle is at 514.13/525 KiB on the integrated SHA, only 10.87 KiB of headroom. Audit `mesh/vite.config.ts` chunk splitting and identify at least one lazy-loadable surface (settings panels, community-platform UI, or emoji/GIF pickers are likely candidates) to create real headroom before Phase C-E work packages add UI. Any subsequent work package that adds a new screen or panel must lazy-load it and must not regress this budget without explicit justification in its own report.

### WP-03 — Deploy and verify the production MatrixRTC/LiveKit/TURN path
**Phase B.**
The repo already contains a production-shaped LiveKit stack with integrated TURN under `mesh/infra/matrixrtc/`; the original claim that no TURN infrastructure exists is stale. Keep MatrixRTC/LiveKit as the only production voice path. Complete the missing operator deployment, DNS/TLS, authorization, TURN allocation, federation, media-E2EE, revocation, and physical-network evidence without committing secrets or requiring a paid Mesh-operated service. This is partly owner-operated infrastructure: prepare and validate source/runbooks locally, but do not invent credentials, mutate a host, or flip release capability flags without live evidence and explicit authority.

### WP-04 — Fix the three confirmed legacy voice-engine bugs
**Phase B.**
In the separate `legacy-p2p`/LAN artifact only, harden `mesh/src/lib/voice-engine.ts`: (1) detect `AudioContext.state === 'closed'` in the speaking-detection path and recreate the context rather than only handling `'suspended'`; (2) call `.stop()` on all tracks of a `MediaStream` before removing it from `relayReceivedStreams` on peer disconnect; (3) replace both call sites of the private `SimplePeer.negotiate()` API with a documented stable renegotiation approach, or isolate a reviewed adapter with a comment explaining the compatibility boundary. Add regression tests for all three. These fixes must not route Matrix release builds through the legacy engine or make legacy P2P the production voice path.

### WP-05 — Real multi-device/multi-network voice acceptance run
**Phase B. Depends on WP-03, WP-04.**
Execute Agent 2's 23-item physical/network acceptance matrix for real (NAT traversal both directions, kick/ban mid-call, app restart mid-call, key rotation with a late joiner, etc.) — currently 0/23 run. Only after this is green should `BackendCapabilities.voice` be flipped on and `media_e2ee_verified` be allowed to report `true`. Do not flip these flags based on unit/integration tests alone; this specific gate is explicitly about physical-network conditions unit tests cannot exercise.

### WP-06 — Persistent voice channels with sidebar occupancy
**Phase C.**
Design and ship Discord's core mechanic, adapted to Mesh's architecture: a voice channel is a standing, joinable room (mapped to a MatrixRTC "slot" per Section 4.2) with live occupant avatars rendered inline in the channel list, one-click join with no ring/accept step, and a text channel attached to every voice channel by default. This depends on WP-05 being green — do not ship this UI ahead of working voice underneath it.

### WP-07 — Persistent, voice-independent text channels with offline sync
**Phase C.**
Audit whether any current channel type implicitly requires voice-channel presence for text access (per Section 4.5, this is TeamSpeak's #1 blocker and a trap worth actively checking for). Confirm/ensure message history syncs correctly across reconnects independent of voice state, using the existing offline message queue (already implemented per project memory) as the foundation — extend it if gaps are found rather than rebuilding it.

### WP-08 — Onboarding pipeline: rules gate → interest questions → personal sidebar → reversible Channels & Roles tab
**Phase C.**
Implement Discord's onboarding mechanic end to end: an acceptance gate blocking send/react/join-voice until rules are accepted; admin-configured default channels; interest/customization questions where each answer both grants a role and adds specific channels to that individual member's sidebar (not global); and a persistent, self-service "Channels & Roles" settings tab so the choice is reversible without contacting a moderator. This must respect `AGENTS.md`'s onboarding simplicity mandate — protocol concepts stay hidden even inside this flow.

### WP-09 — Recovery key delivery via OS keychain/password manager with health check
**Phase C.**
Given Mesh already stores identity keys in the OS keychain (an existing differentiator), extend the same delivery model to any user-facing recovery key: offer direct OS-keychain/password-manager storage as the primary path (not a downloadable .txt), validate entry with a checksum so "wrong key" is unambiguous, and add a recurring background health check that performs a real round-trip validation rather than just checking the key is present. Explicitly design the wire format and UI treatment for recovery to be visually and structurally distinct from a key-rotation ban event — see invariant #1, Section 1. This is a security-critical design decision; do not let it be implemented ambiguously enough that the two cases converge.

### WP-10 — Ban vs. recovery UX and wire-signal separation
**Phase C. Depends on WP-09.**
Explicitly test and document (with a diagram or table in the PR) that a legitimate device-recovery event and a cryptographic-ban event produce different signals at both the protocol/wire level and in every UI surface a community member would see (member list, system messages, notifications). If any current code path conflates these, fix it before shipping WP-09.

### WP-11 — Read receipts and typing indicators: off by default, reciprocal, per-conversation
**Phase C.**
Per invariant #3, audit current presence/typing/receipt behavior. Ensure indicators are opt-in, reciprocal (a user only sees others' status if they share their own), scoped per-conversation, and cannot be queried passively by a peer without the local user's own signal being sent first. Treat any gap here as a security bug, not a feature request.

### WP-12 — Notification content minimization
**Phase C.**
Audit OS notification payloads. Default to "New message from `<name>`" with no message content, consistent with invariant #4. Make full-content previews an explicit opt-in setting with a clear warning about lock-screen/notification-center exposure.

### WP-13 — Adopt the Cinny-style container-quintuple design token system
**Phase D.**
Rebuild (or extend, if a compatible system already exists in `mesh/src/styles`) the color token layer so every role (background, surface, accent, danger, etc.) is expressed as a five-value set — Container / ContainerHover / ContainerActive / ContainerLine / OnContainer — generated algorithmically (OKLCH-based, per Section 4.7) rather than hand-picked per component. Audit existing components for any hard-coded hex/hover colors and migrate them. This is the concrete mechanism behind the project's "rival Discord" design mandate — treat it as foundational, not cosmetic polish, and sequence UI-heavy work packages (WP-06, WP-08) after this where feasible.

### WP-14 — SequenceCard pattern for list-heavy surfaces
**Phase D.**
Implement the `:not(&) + &` / `&:not(:has(+&))` CSS pattern (Section 4.3) as a shared utility and apply it to settings screens, member lists, and any other consecutive-row UI, replacing ad hoc per-row rounding.

### WP-15 — Command palette (⌘K) with sigil-scoped search
**Phase D.**
The current app already ships `Ctrl/Cmd+K`, recents, commands, and keyboard navigation. Extend it with sigil scope (`#` channels, `@` DMs, `*` communities), activity-sorted empty state, and breadcrumb context per row (parent community, or a DM contact's account service). Do not rebuild the existing command palette.

### WP-16 — Accessibility pass to WCAG 2.2 AA
**Phase D.**
Concrete, testable items: `role="log"` with implicit `aria-live="polite"` on the message list, present and empty at mount; roving tabindex and `aria-setsize`/`aria-posinset` on virtualized message rows (confirm the current virtualization library supports bottom-anchored/reverse lists correctly — Section 4.7 specifically calls out `react-virtuoso` over `react-window` for this); a non-drag equivalent for every drag interaction; a minimum 24×24 CSS px hit target on every interactive element including reaction chips and hover-only actions (use invisible hit-area expansion where the visual element must stay smaller); and an accessible-authentication-compliant path for any flow that currently asks a user to read/transcribe a key or fingerprint (copy/paste, QR, and file-based alternatives must all be present). Run an automated audit (e.g. axe-core in CI) plus one manual screen-reader pass per platform before marking this done.

### WP-17 — Motion, transparency, and loading-state discipline
**Phase D.**
Add a user-controllable transparency slider (default ~0.85 opacity) rather than a fixed glass aesthetic; cap `backdrop-filter` blur at 8-12px and restrict it to small non-scrolling surfaces (modals, context menus, voice HUD) — never the message list. Replace any spinner-only loading states with skeleton states. Audit all transitions for repetition fatigue (per Section 4.7, chat UI motion is seen far more often per session than typical UI motion) and ensure a `prefers-reduced-motion`-safe variant exists for every animated affordance, especially the speaking-indicator ring.

### WP-18 — Four-tier permission resolver (TeamSpeak model), Simple/Advanced toggle
**Phase E.**
Design and implement the Server Groups → client-override → Channel Groups → channel-specific resolution order with `skip` and `negate` flags, plus power/needed-power integer pairs per moderation verb, stored as extensions on top of Matrix's existing power-level primitive rather than replacing it (respect `AGENTS.md`'s requirement to keep permissions on the Matrix control plane). Ship it behind a Simple (role-template-based, current UX) / Advanced (full resolver) toggle — do not expose the full engine as the default surface, per TeamSpeak's own documented failure mode.

### WP-19 — Three channel lifetimes with member-grantable temporary-channel creation
**Phase E.**
Add semi-permanent (cleared on restart) and temporary (auto-removed when empty) channel lifetimes alongside the existing permanent type, with a grantable permission allowing ordinary members to create temporary child channels under a designated parent.

### WP-20 — Opus voice-profile dial, Priority Speaker, Whisper Lists
**Phase E. Depends on WP-05.**
Expose a per-channel Opus quality dial with named "Voice" (efficiency) and "Music" (fidelity) profiles plus forward error correction, publish the resulting bandwidth formula in user-facing docs. Add Priority Speaker (client-side gain ducking of other participants) and Whisper Lists (selective peer audio routing) as new, cheap-to-implement differentiators — Section 4.5 notes both should be materially cheaper to build on Mesh's P2P transport than on TeamSpeak's client-server model.

### WP-21 — Cryptographic invite links with live occupancy embeds
**Phase E.**
Ensure all onboarding happens via signed invite links (never IP-address-based, per the TeamSpeak anti-pattern), and extend invite link previews/embeds to show live community/channel/occupant-count data where the inviter's client can safely provide it, per Discord's June 2026 mechanic. Verify this doesn't leak presence/occupancy to anyone who merely holds a stale link — gate live data behind an active, revocable invite state.

### WP-22 — Browser-style pinned room tabs
**Phase E.**
Ship Nheko/Komai's multi-conversation tab model (open several rooms side by side, pinned, reorderable, restored on relaunch) as a genuine differentiator with no Discord equivalent. Sequence after WP-02's bundle-budget work since this is new UI surface.

### WP-23 — Trademark clearance for "Mesh"
**Phase F. Not an engineering task — route to a human/legal owner immediately, do not block engineering on its outcome but do not ship paid marketing spend or a public 1.0 launch under the current name until resolved.**
Section 4.6 documents Revolt's loss of its own name to a cease-and-desist mid-growth, at direct cost to brand/SEO equity. Commission (or have the product owner commission) a trademark search for "Mesh" in the relevant classes (software/communications) before any wider public launch.

### WP-24 — On-device-only AI constraint, written into the codebase
**Phase F.**
Add an explicit architectural guard (lint rule, code comment convention, or CI check) preventing any AI/ML feature from requiring network access to a third-party inference service or from being granted autonomous send/moderation authority, per invariant #2. If a specific AI feature (e.g. local live captions, per Section 4.7) is planned, scope it now with this constraint written into its spec, not bolted on after.

### WP-25 — Publish resource-usage benchmarks (idle RSS, cold start)
**Phase F.**
Instrument and publish Mesh's idle RAM usage and cold-start time versus Discord's documented ~4GB-admission ceiling, per Section 4.1's "sharpest wedge" finding. This should become a standing CI-tracked metric, not a one-time blog post number, so regressions are caught automatically.

### WP-26 — Re-run the full Section 10 verification matrix and close Definition of Done (Section 14)
**Phase F. Final gate.**
Nothing in this plan is complete until every item in Section 10 passes fresh on the final SHA, and Section 14's Definition of Done is satisfied in full, including the live/manual acceptance items that cannot be verified by CI alone.

---

## 9. Release gates (in order; do not skip)

1. WP-00 and WP-01 are already green on integrated SHA `7effb0c`.
2. WP-03 through WP-05: the MatrixRTC/LiveKit production path physically acceptance-tested before `BackendCapabilities.voice` is ever set `true` in a Matrix release build. Legacy P2P evidence does not satisfy this gate.
3. WP-09/WP-10: recovery and ban are provably distinguishable before any wider beta invites go out (a false-positive "you've been banned" read on a legitimate recovery is a trust-destroying bug, not a cosmetic one).
4. WP-16: WCAG 2.2 AA automated + manual pass before any public 1.0 announcement.
5. WP-23: trademark search initiated before any paid marketing or press outreach, regardless of engineering status.

---

## 10. Verification command matrix

Run all of the following on the final SHA for any work package claiming completion; do not reuse numbers from a prior doc.

- `npm run test` (Vitest, full suite)
- `npm run e2e` (Playwright, full suite; generated `mesh/test-results/` and `mesh/playwright-report/` are disposable and must not be mistaken for durable evidence)
- `cargo test` with `--features matrix-backend` (default) and separately with `--features legacy-p2p`
- `npm run check:design-tokens`
- IPC contract check (regenerate and diff `mesh/src/types/ipc.generated.ts`)
- `cargo audit` (confirm 0 advisories in the default `matrix-backend` build; document any remaining `legacy-p2p`-only advisories as accepted/scoped, per existing precedent)
- Bundle-size check against the 525 KiB eager-JS budget (Section 8, WP-02)
- axe-core (or equivalent) automated accessibility scan, plus one manual screen-reader pass per supported OS
- The 23-item physical/network voice acceptance matrix in Agent 2's current brief—manual, not CI-automatable; it must show 23/23 `run` with pass status before voice capability flags change

---

## 11. Live/manual acceptance matrix (cannot be verified by CI)

- Full voice acceptance matrix (NAT traversal both directions, mid-call kick/ban, mid-call app restart, key rotation with a late joiner, relay-peer disconnect cleanup) — see WP-05.
- Fresh-device encrypted-history-recovery flow, performed on a genuinely new physical/virtual device, not a reset simulator.
- Screen-reader pass on Windows (NVDA), macOS (VoiceOver), and Linux (Orca) if Linux desktop is a supported target.
- Cross-webview visual/functional check (WebKitGTK on Linux is a documented Tauri pain point per Section 4.7 and disproportionately affects the privacy-conscious Linux segment of Mesh's target audience).

---

## 12. Owner-operated and external blockers

- **TURN/SFU infrastructure** (WP-03, WP-05) requires a hosting/ops decision. It may be an optional community/BYOH service, but Mesh must not require a paid Mesh-operated homeserver or calling service. Flag owner action rather than silently creating a recurring cost.
- **Trademark clearance** (WP-23) requires legal engagement outside engineering's control.
- **Any product decision that changes the account-service/onboarding flow described in `AGENTS.md`** must go back to the human owner, not be inferred by Sol.

---

## 13. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Ban/recovery signal conflation ships unnoticed | Medium | High — destroys trust in the core differentiator | WP-10 explicit test before WP-09 ships |
| Voice capability flag flipped on unit-test-only evidence | Medium | High — repeats the exact failure Discord/Stoat suffered publicly | WP-05 hard-gates the flag on the 23-item physical matrix |
| "Mesh" trademark dispute post-launch | Medium | High — direct precedent in Revolt/Stoat | WP-23 started now, independent of engineering timeline |
| Bundle budget exceeded by Phase C-E UI work | High if unmanaged | Medium — perf regression, slower first paint | WP-02 first, budget check required in every subsequent UI PR |
| AI feature scope creep introduces network-dependent or autonomous behavior | Low today, rises over time | High — direct security/trust violation of invariant #2 | WP-24 codifies the constraint before any AI feature is scoped |

---

## 14. Definition of done for this plan

All Phase A-C work packages verified green per Section 10; the 23-item voice acceptance matrix at 23/23; WP-09/WP-10 ban-vs-recovery distinction demonstrated with a written test case, not just code review; WP-16 accessibility pass complete with automated + manual evidence attached to the PR; WP-23 trademark search initiated with a documented outcome (clear, conflict, or pending); every claim of "done" in any report traceable to a command output attached to that report, not to a prior document's claim.

---

## 15. Agent reporting template

Use this exact structure for every work package report:

```
## Tranche report — [WP-ID and title]

**Files touched:** [list]
**What changed and why:** [1-3 sentences]
**Verification run:** [exact commands + pass/fail output, not a summary]
**Deviations from this plan, if any, and why:** [or "none"]
**New issues discovered:** [or "none"]
**Next incomplete work package:** [WP-ID]
```

---

## 16. The next incomplete work package and its first executable step

**WP-02 — Bundle budget triage before new UI work.**
First executable step: from `mesh/`, run `npm run build` and `npm run check:bundle-size`, record the current chunk graph, then identify the largest safe lazy boundary without changing behavior. This work is owned by Agent 3 and can run in parallel with Agent 1's security/privacy audit and Agent 2's MatrixRTC/legacy-hardening work.
