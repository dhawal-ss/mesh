# Mesh design language: Material 3 Expressive

Status: implementation contract  
Applies to: Windows, macOS, and Linux public beta, light, dark, and high-contrast themes

Material 3 Expressive makes Mesh feel like a set of soft, separable panes rather than a ruled instrument. The interface is a family of tonal surfaces, stepped in lightness and cut to a shape scale, with colour spent on two jobs and nothing else. Its one rule: **tone and shape carry structure; colour carries exception. Silence is still the default state, and coral is still the sound an exception makes.**

The decentralized nature of the product -- homeserver, federation, end-to-end encryption, device trust -- is communicated by one chip per screen and one card per fault, never by prose beside every message.

## Principles

1. **Depth is tonal, not linear.** Panes are separated by a step in surface tone and a 28 px radius, never by a 1 px rule. What survives of the hairline is Material 3's own divider: a rule between rows *inside* one surface, in `--outline-variant`. Structure between surfaces is never drawn.
2. **Everything you touch has a radius.** The shape scale is the system; there is no 0 px structural plane, and `--shape-none` exists only for full-bleed media.
3. **Colour is spent on two jobs.** Azure carries structure, selection and your own words. Coral carries exceptions, mentions and destructive actions. Amber marks pinned and live. Neutrals are chroma-free.
4. **Exceptions still speak, and now they are the only red thing on the screen.** A healthy, decrypted, verified message carries no badge. Coral appearing anywhere means something needs a person.
5. **State is still readable without colour.** Every M3 colour role pairs with an icon, a label, or a shape change. Selection is a filled pill *and* `aria-current`. Speaking is an outline *and* the word.

## Positioning against Discord

Mesh keeps the left community rail, adjacent channel or conversation list, central message or call surface, optional right people pane, familiar composer placement, message actions, unread markers, and persistent call controls. A Discord user should know where to look without instruction.

Mesh deliberately differs in five ways:

- Home, Direct Messages, and community overviews use one editorial continuation target followed by a list of resumable rows. This improves resumption instead of presenting an empty canvas.
- Panes are inset rounded surfaces separated by a step in tone. Shape and tone explain structure; shadow is reserved for content that is actually overlaid.
- Federation and encryption state is ambient. One assist chip in the app bar, one badge on a mark whose owner is on another homeserver, and a coral card only when something is wrong replace per-message protocol prose.
- Account-service choice is explicit, and invitations do not bind account hosting to community hosting. This is a product and trust improvement, not visual novelty.
- Voice remains visible through a persistent call bar after navigation. This makes an ongoing media state harder to lose.

The chroma-free neutrals, the pixel heart, and the hashed identity marks are visual character. They are intentionally different, but are not claimed as functional improvements.

## The shape of a room

A room can be read three ways on this device. A shape changes what the surface promises and nothing else: the same messages, the same membership, the same permissions, the same composer. It is not a room type on the wire, so declaring one cannot fail, cannot need a power level, and cannot desynchronise from the server. Nobody else's view changes.

| Shape | What it promises | Built from |
| --- | --- | --- |
| Conversation | The transcript, in order. The default, and never stored | The messages |
| Clips | A gallery, because in a room full of screenshots the picture is the content and the words are the caption | Messages the media classifier already recognises |
| Event | One answer pulled to the top: who is coming | The pinned message, and reactions on it |

Each shape is derived from something the room already has. An event's plan is the room's pinned message and its replies are reactions, so somebody reading that same room as a conversation sees a pinned plan with ticks on it, which is what a group does by hand anyway. A shape that needed its own wire format would be a room type, would need a power level, and would have a failure mode; none of these do.

The reply set is fixed at three, because a fourth option is a conversation and the room is already that. A chosen reply is marked by a bar and a fill, never by colour alone. `ClipsView.tsx` and `EventView.tsx` still carry the geometry that predates this contract; the behaviour they implement is unchanged.

## Typography

One family, vendored locally. `Roboto Flex` through `--font-sans` carries every role in the product, variable across `opsz 8..144` and `wght 100..900`. It is resolved out of the installed dependency tree at build time and emitted into `dist/`, which is what keeps its OFL notice generated rather than hand-maintained; Mesh is a Tauri binary that has to render with no network, so no face is ever fetched from a font host. There is no `--font-mono` and no second UI family: `--font-code` is a system stack that ships no bytes, and it survives in exactly one job -- a machine value a person copies rather than reads. That is a fenced code block in `MarkdownContent.tsx` and the `<code>` primitive in `Primitives.tsx`, a device key in `SecurityDevicesPanel.tsx`, a session id in `DiagnosticsPanel.tsx`, and the recovery grid in `BackupCodeScreen.tsx`. Nothing is uppercased; M3 label styles are sentence case, and the uppercase eyebrow is gone with them.

Weights 400, 500, and 600 are permitted. The M3 roles use 400 and 500; 600 is reserved for editorial emphasis inside prose and carries no role of its own. The scale is closed and carries the M3 role names:

| Token | Size | Line height | Letter spacing | Weight | Use |
| --- | ---: | ---: | ---: | ---: | --- |
| `--type-display-lg` | 57 px | 64 px | -0.25 px | 400 | The one poster heading in setup |
| `--type-display-sm` | 45 px | 52 px | 0 | 400 | Secondary screen title |
| `--type-headline-lg` | 32 px | 40 px | 0 | 400 | Route title, large app bar |
| `--type-headline-md` | 28 px | 36 px | 0 | 400 | Pane heading |
| `--type-title-lg` | 22 px | 28 px | 0 | 400 | Small app bar title, modal title |
| `--type-title-md` | 16 px | 24 px | 0.15 px | 500 | List item headline, room name |
| `--type-title-sm` | 14 px | 20 px | 0.1 px | 500 | Dense title |
| `--type-body-lg` | 16 px | 24 px | 0.5 px | 400 | Message text |
| `--type-body-md` | 14 px | 20 px | 0.25 px | 400 | Supporting text |
| `--type-body-sm` | 12 px | 16 px | 0.4 px | 400 | Captions |
| `--type-label-lg` | 14 px | 20 px | 0.1 px | 500 | Buttons, tabs |
| `--type-label-md` | 12 px | 16 px | 0.5 px | 500 | Chips, navigation labels |
| `--type-label-sm` | 11 px | 16 px | 0.5 px | 500 | Timestamps, badges |

Eleven pixels is the floor for anything informational. The 9.5 px uppercase eyebrow and the 10 px count are retired, and no step below `--type-label-sm` may be added to carry them back.

A grey that carries information must clear 4.5:1 on the ground it sits on. `--on-surface-variant` at 11.22:1 is the ordinary supporting ink. `--outline` at 5.88:1 is the control boundary (WCAG 1.4.11 asks 3:1 of one) and is legal as text at any size because it clears the body floor; `--outline-variant` at 1.40:1 is decorative and may never carry text or the shape of a control.

Text must reflow at native 200 percent Windows text scaling without hiding controls, horizontal scrolling of prose, or loss of status. Truncation is allowed only when the full value is available through an accessible name or adjacent detail. `--text-scale` reaches 1.5, which puts the display step at 85.5 px rather than the 114 px the previous 76 px display step reached, and `e2e/text-scale-reflow.spec.ts` measures that no heading exceeds its own box and no page scrolls sideways at 100, 125 and 150 percent across three window sizes.

## Copy

Copy is a control surface, not a page. Every sentence has to change what somebody does; a sentence that explains how Mesh works, reassures the reader, or restates the label above it is the app talking about itself, and it goes.

- **A line that reads the same on every row is a caption, not information.** If a slot cannot vary between rows, it holds nothing. The direct-message list printed "Private conversation" under every name, and the inbox printed "Something new" beside a numeral that already said how many; neither told anybody which row to open. The corollary is that a slot with no data to fill it stays empty rather than taking filler: a room with no topic gets no line, because an unwritten topic is itself information and a stand-in hides it.
- **A section that exists only to say it is empty collapses.** A heading, a zero, and an empty state cost more of the surface than the thing they are standing in for.
- **A transient state names what is happening and stops.** "Opening Field Notes" is the whole message; a second line reassuring somebody that Mesh is keeping their destination ready is the app narrating itself while they wait.
- **A control that duplicates an adjacent control goes.** A button whose only job is to focus the composer thirty pixels below it is chrome, not an affordance.
- **Labels are labels.** A settings-nav item, a tab, a section heading and a menu entry carry a name and nothing else. A three-item list does not need a subtitle under each item.
- **Field hints are constraints, not lessons.** "PNG, JPEG or WebP. Up to 1 MB." The formats and the limit change what somebody does; how Mesh stores the file does not.
- **An empty state is one line and one action.**
- **An error names what happened and what to do,** in that order, and stops. No apology, no cause.
- **Buttons are verbs.**
- **Nothing explains what a feature is for.** People click and find out.

Two exceptions earn their words. A destructive action states what is lost and who else is affected. A privacy, security, or data-location fact states the fact. Both are written as short as the fact allows, and neither is padded with reassurance.

`scripts/check-copy-density.mjs` enforces the shape: no user-facing string runs past 16 words or two sentences. Sixteen is the renderer's own ninetieth percentile, so the limit bites the tail where the essays live rather than the middle. Two sentences stay legal because "That did not work. Try again." is the right shape for a failure and a sentence-count rule would have banned it alongside the paragraphs. Copy that genuinely needs more is recorded with the fact a reader would lose, which makes an exception visible instead of ambient.

One clause is amended by this contract. "The norm gets no words" becomes **the norm gets one chip per screen and no words per message**: a single assist chip in the app bar states that the room is encrypted and how many people are on other servers, and no message carries a label saying the same thing again. Everything else in this section stands, including the 16-word limit.

## Spacing and density

The base spacing unit is 4 px. Permitted relationships are 4, 8, 12, 16, 20, 24, 28, 32, and 40 px. Use 4 to bind icon and label, 8 for content within a compact control, 12 for the gap between panes, 16 for a component group and for the inset of a card within a pane, 20 or 24 for section rhythm, and 28, 32, or 40 only between major route regions. The conversation column uses 16, 20 or 24 px of horizontal padding depending on the surface; there is no row-number gutter and no message time column.

`compact`, `default`, and `comfortable` change row padding, panel gaps, and line height through `--density-*`. They do not remove labels, focus indicators, or status. Interactive controls remain at least 32 px high in every density. Default control heights are 40, 48, and 56 px, and a primary touch target is 48 px.

## Color system

Color has three tiers:

1. Reference tokens, `--ref-*`, hold literal values only.
2. Semantic tokens name an M3 role, such as `--surface-container-high`, `--on-surface-variant`, `--error`, and `--border-focus`.
3. Component tokens may narrow a semantic role; they may not contain new literals.

A new color enters only at the reference tier and must be consumed through a semantic name before a component uses it. Components and Tailwind configuration never use hex, numeric RGB, OKLCH literals, stock palette classes, or reference tokens directly. This rule predates this contract and outlives it.

The neutral ramp is chroma-free, which is what stops the palette reading as stock Material. Six container tones -- `--surface-container-lowest`, `--surface-container-low`, `--surface-container`, `--surface-container-high`, `--surface-container-highest`, and the `--surface` ground -- are six distinct values, and a pane is separated from its neighbour by a step between them rather than by a rule. Structural hairlines are gone: `--outline-variant` draws a boundary only where a card genuinely has no tonal step available to it.

Three chromatic families, and no fourth. Azure is `--primary` and its containers, and carries structure, selection, and your own messages. Coral is `--error` and its containers, and carries exceptions, mentions, and destructive actions. Amber is `--marker` and its containers, and carries pinned and live. Green is not a UI colour in this system: a healthy state is silence plus the one chip, and speaking in a call is `--primary`. That is what keeps coral meaning something.

Interaction is drawn with M3 state layers rather than with fill tokens -- `--state-hover` at 0.08, `--state-focus` and `--state-pressed` at 0.10, `--state-drag` at 0.16, each composited over the role colour underneath. A control with no ground of its own takes the layer; a control that has one takes a hover face in its own family, which is what `--primary-hover`, `--error-hover` and `--marker-hover` are for. Reaching for a container's hover face from a solid fill puts an on-colour on the wrong ground.

A tonal container is a solid colour, not a tint, so it carries exactly one legible foreground for its whole subtree: text sitting on `--marker-container` takes `--on-marker-container`, and neither the role's own ink nor a neutral one is legal there.

A person may choose one of six accents, and an accent re-points `--primary` and the two containers built from it. It introduces no fourth colour job: coral still means exception and amber still means pinned whichever accent is chosen. Each accent carries a container dark enough to hold its own ink, which is a different reference step from the mid-tone the accent itself uses.

Light and dark are independently specified complete themes; light is not derived by flipping dark. High contrast is a complete functional theme, not an inversion: it keeps the M3 roles, pushes every on-colour to pure white or pure black, and pairs every container at 7:1. Every text and control pairing must meet WCAG AA: 4.5:1 for normal text and 3:1 for large text, focus indicators, boundaries that convey state, and non-text controls. Selection, presence, speaking, warning, and failure always include a non-color cue.

## Elevation, radius, and border

Elevation is a five-step ladder plus a true zero. `--elev-0` is `none` and is what everything in normal document flow uses: a pane, a card, a list row, a message bubble. Shadow is spent only on things that are actually above the page -- `--elev-2` for a menu, popover, or tooltip, `--elev-3` for a FAB, a floating toolbar, a modal, or a snackbar, `--elev-4` for an item being dragged, `--elev-5` for the largest permitted lift. Tone does the work everywhere else.

The shape scale is the system. `--shape-xs` 4 px, `--shape-sm` 8 px, `--shape-md` 12 px, `--shape-lg` 16 px, `--shape-lg-inc` 20 px, `--shape-xl` 28 px, `--shape-xl-inc` 32 px, and `--shape-full` for a pill or a circle. `--shape-none` is 0 and is legal only on full-bleed media clipped by an ancestor that has its own radius. Every pane is a 28 px rounded surface inset by 12 px from the window and from its neighbours, so there are no shared edges left for a rule to draw.

Four panes do not fit every window, and the widths say where each one stops being a column:

| Width | Rail | Room list | Roster |
| --- | --- | --- | --- |
| 1600 px and up | 88 px column | 340 px column | 400 px docked side sheet |
| 1000 to 1599 px | 88 px column | 340 px column | side sheet over the conversation |
| 640 to 999 px | 88 px column | drawer | side sheet over the conversation |
| Below 640 px | 64 px column, labels hidden | drawer | side sheet over the conversation |

The rail, the list and the roster plus four 12 px gaps are 876 px of chrome. A 1600 px window keeps 724 px of conversation and a 1366 px one keeps 466 px, which is less than the composer needs, so below 1600 the roster is the modal counterpart M3 gives a docked side sheet. Below 1000 px the frame goes full-bleed and the panes lose their inset: a 12 px gutter on four sides is 24 px taken from a window that has none to spare. Focus uses a 2 px explicit outline with a 2 px offset through `--border-focus`, and never becomes the primary colour: M3's own focus indicator is not a substitute for an authored focus state.

## Motion

Motion communicates cause and continuity:

| Role | Duration | Use |
| --- | ---: | --- |
| Press | 50 ms | Physical button response |
| Micro | 100 ms | Hover and small state acknowledgement |
| Fast | 150 ms | Menu and tooltip arrival |
| Base | 200 ms | Local state transition |
| Deliberate | 250 ms | Panel or route context change |
| Maximum | 300 ms | Largest permitted spatial transition |
| Activity | 1000 ms | Bounded progress or live activity |
| Highlight | 2000 ms | One-shot navigation target highlight |

Arrival uses `--motion-ease-arrive`, emphasis uses `--motion-ease-emphasize`, and repositioning uses `--motion-ease-reposition`. Opacity and transforms may animate; layout motion must not make reading targets move unexpectedly. Indefinite decorative pulse, overshooting springs, and hardcoded Framer Motion distances are prohibited.

Reduced motion removes spatial travel and repeated decorative movement while preserving the resulting state, focus transfer, status text, and bounded progress. A transition may become an immediate opacity change, but a process indicator may not disappear merely because duration is reduced. Identity rotation is static and is therefore unaffected by reduced motion.

## Federation and encryption

Three carriers, in order of prominence, and no fourth.

- **One assist chip in the app bar.** `--surface-container-high` with a `shield` glyph and a sentence-case label: "Encrypted, 3 on other servers". One per screen, never one per message.
- **A badge on the mark.** An avatar whose owner is on a different homeserver carries a 16 px `--marker-container` badge with a `globe` glyph. It replaces the 1 px chrome ring and works in member lists, conversation lists, palette results, and the voice roster. The badge is decorative, so every surface that shows one names it in words nearby: a legend card in the member list and the conversation list, and the peer's homeserver as the subtitle of a direct-message header.
- **A coral card, inline in the timeline, only when something is wrong.** An undecryptable event, an unverified device, a withheld key, or a failed federation send earns an icon, what happened, what to do, and one button. This is the only place coral appears in the timeline.

Green leaves the product: a local, decrypted event from a verified device is the norm, and the norm is silence plus the one chip. Per-message encryption labels, per-message origin-server labels, composer encryption strips, and padlock iconography are prohibited. The shell-level connection band is retained as an `--error-container` banner: a degraded link is an exception and has earned its words.

`lib/trust.ts` keeps `eventTrust`, `serverName`, and `serverRelation` unchanged. Only its label function changes, from a rail tooltip into the accessible name carried by the badge and the card.

## Iconography

All UI icons route through `src/components/ui/Icon.tsx` and Lucide. Material Symbols Rounded was considered and rejected: it is the M3-native answer, but it would add a font file to a stylesheet and asset budget that is already at its ceiling, and it would delete the stroke assertions that make the single central icon path enforceable. Lucide at a heavier stroke reads correctly at M3 sizes and keeps this a one-file swap.

Sizes are 20 px `sm`, 24 px `md`, and 40 px `lg`. Stroke is 2 px, or 2.25 px for `lg`, with absolute stroke width. `xs` survives as an alias pointed at 20 px so its call sites keep compiling; it names no step of its own and takes no new ones. Icons align to the text cap-height or the center of a square control; they do not receive arbitrary offsets. The 14 px and 18 px steps are retired: they are below the M3 target sizes and were only ever used to fit the ruled geometry this contract replaces.

An icon may appear without a visible label only when the action is conventional in context and the control has a precise accessible name. Ambiguous actions, destructive actions, onboarding choices, call state, and errors keep visible text. Decorative icons are hidden from assistive technology.

## Component anatomy and states

Every interactive component has an authored focus-visible state. Browser-default focus alone does not conform. `disabled` suppresses activation but retains enough contrast to explain the control; `loading` preserves geometry and names the process; `error` names what happened and the next action.

| Surface | Anatomy | State contract |
| --- | --- | --- |
| Message bubble | Avatar on the first of a group, one metadata line, bubble with a 6 px tail corner, attachments clipped to the bubble, reaction chips, contextual actions | Default is flat at `--elev-0`; hover reveals an action pill without moving content; focus-visible outlines the active action; selected or targeted adds a shape change plus text cue; disabled actions remain named; loading preserves row position; error is inline and retryable |
| Composer | Attachment action, labelled editor, formatting affordance, send action, upload and reply context | Focus-within receives the authored focus outline; active send has text/icon state; disabled explains why; loading keeps draft visible; send error preserves the draft and provides retry |
| Channel list item | Type glyph, name, optional unread badge, live state | Hover and focus apply a state layer, not a fill token; focus-visible outlines the row; active is a `--secondary-container` pill plus `aria-current`; disabled retains the name; loading uses stable rows; error stays scoped to the list |
| Community rail item | Real community or product asset, unread badge, accessible name | Rest is a circle and selected is a `--shape-lg` tile, so the shape change is itself the selection cue; hover and focus are distinct; selected has a marker plus accessible state; loading never substitutes a fake asset; error exposes recovery text |
| Member row | Avatar, display name, optional handle, role chip or presence, call state | Presence and speaking pair color with text/icon/shape; focus reveals permitted action; selected and disabled remain readable; loading and error do not reorder the list |
| Modal | Labelled title, concise consequence or task, content, ordered actions | Opens above a scrim at `--elev-3` with trapped focus; initial focus is safe; Escape and cancel restore focus; destructive confirmation is explicit; loading locks duplicate submission; error stays inside the modal |
| Snackbar | Status icon, short message, optional one text action, dismiss | Uses `role=status` or alert semantics appropriate to urgency; never carries a multi-step task; hover pauses dismissal; focus reaches the action; error states name recovery |
| Empty state | Plain heading, reason, one obvious action, optional secondary guidance | No decorative card stack; focus begins at the heading or action; loading is not shown as empty; error uses the error-state anatomy |
| Error state | What failed, user impact, next action, optional reviewed details | Error color is paired with icon/text; retry is focusable; raw protocol detail stays behind an explicit disclosure; disabled retry explains its condition |
| Call tile | Media or avatar, participant name, self marker, mute state, speaking state, connection state | Hover may reveal local controls; focus-visible outlines the tile/control; speaking uses a 3 px inset outline plus the word; selected means locally focused; disabled controls remain named; reconnecting and error preserve identity and provide status |

## Voice and video

Voice is a primary route, not an overlay-only utility. Joining is one action. Messages remain reachable during a call.

- A call tile keeps the participant name and audible state visible over media. Camera-off uses the real avatar, not a placeholder illustration.
- Speaking uses a 3 px inset `--primary` outline plus the word `Speaking` in the tile's state chip. Muted, listening, reconnecting, and disconnected are distinct text/icon states, and muted is an `--error-container` chip.
- With 2 participants, use two equal tiles. With 3, feature the active speaker across the first row and place two equal tiles below. With 4 to 8, use a responsive grid with no tile smaller than the useful name and status overlay; at 8, use four columns by two rows at 1280 by 720 and reduce columns before shrinking readable content.
- The active speaker may be featured, but every participant remains visible without opening a secondary panel for groups of eight or fewer.
- The persistent call bar remains in the application shell after navigation, as an M3 floating toolbar. It names the room, connection state, participant count, mute state, deafen state, leave action, and one action to return to the call. Compact layouts may hide redundant visible labels but retain accessible names and state.

## Mechanical enforcement

`scripts/check-design-tokens.mjs` enforces the closed typography, local font ownership, theme and density selectors, minimum controls, token-only component colors, semantic contrast pairs, geometry, elevation, motion values, reduced-motion support, central icon path, call-state hooks, and this document's required sections. It additionally asserts that the elevation ladder exists with level 0 at `none`, that every value on the shape scale is non-zero except `--shape-none`, that the six surface container tones are six distinct values, that Roboto Flex is vendored locally, and that no component file contains a hex, `rgb()`, `oklch()` or a `--ref-*` reference. `scripts/check-container-contrast.mjs` measures sixteen text pairs and four container boundaries out of this stylesheet rather than against literals typed into a checker, in the dark, light and high-contrast themes. It asks branch agreement -- that a token's `color-mix` override and its fallback resolve to the same colour -- of the container and its boundary only. Those two carry a measured requirement and are declared twice in every theme; a hover and a pressed face are transient, nothing measures them, and they are derived perceptually because a block that re-points `--primary` cannot also carry the composited values that follow from it. Visual review enforces hierarchy, anatomy, responsive composition, and whether a screenshot satisfies the five principles.

## Budget decision

Material 3 Expressive reuses the existing token architecture rather than introducing a second styling approach: an elevation ladder, a shape scale, and state layers are added, and the four structural alpha fills, the hairline rules, the trust rail, the state tick, the conversation-title header, the mono family and its whole class surface, and the sub-11 px type steps are removed. `check:bundle-size` measures each current build against the checked-in JavaScript and CSS ceilings; historical measurements are not part of this contract. The CSS ceiling is the binding constraint and no increase is requested.

Pixel-art masks are emitted as cacheable files instead of base64 stylesheet data. Lightning CSS performs behavior-preserving minification, and a tested PostCSS liveness pass removes source tokens that no compiled rule or renderer source can consume while preserving the complete source design contract.

Performance claims must come from the current performance fixtures or signed installed-build acceptance. Historical preview measurements are not release evidence.

## What this contract has not reached yet

Every surface carries the palette, the type scale and the shape scale. Five have not had their layout rebuilt, and each is named here rather than left for a reader to discover:

- **Direct messages.** The extended FAB for a new chat, and the medium top app bar over the conversation. The two-line list item is done.
- **People.** The docked side sheet's primary tabs and the Online / All / Admins filter chips that replace its section headings.
- **Settings.** The standard navigation drawer, the M3 switch, and the text-scale slider.
- **Onboarding.** The wavy linear progress indicator and the step chip.

The pixel heart is also still the mask it was: recolouring it into this palette and emitting it as a gutter-free 16x16 bitmap is outstanding. `DESIGN_CONFORMANCE.md` is not reinstated -- the file, its 102 audit screenshots and the Playwright project that captured them were removed under the publication policy for this repository, and restoring a design document to a public tree is not a decision this contract can make for its owner.
