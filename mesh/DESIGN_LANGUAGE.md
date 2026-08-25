# Mesh design language: Quiet Structure

Status: implementation contract  
Applies to: Windows, macOS, and Linux public beta, light, dark, and high-contrast themes

Quiet Structure makes Mesh feel like a precisely ruled instrument rather than a warm notebook. The interface is a single near-black ground whose architecture is exposed through hairline rules, mono micro-labels and numbered rows. Its one rule: **everything soft except the structural marks, which are dead sharp. Silence is the default state; only exceptions speak.**

The decentralized nature of the product -- homeserver, federation, end-to-end encryption, device trust -- is communicated ambiently rather than in prose beside every message.

## Principles

1. **The norm gets no words.** A message from your own homeserver, decrypted cleanly, from a verified device, is the norm, and it carries no badge, no icon and no label. Mesh refuses to restate a healthy state.
2. **Only exceptions speak.** An unverified device, an undecryptable event, a failed federation send or a withheld key earns a line of text. Mesh refuses to spend the same words on "encrypted OK".
3. **Structure is drawn, not implied.** Panes are separated by a one-pixel rule and rows by a softer one; no surface is darker than its neighbour to suggest a boundary. Mesh refuses floating cards, diffuse shadows and elevation used as decoration.
4. **Sharp where it structures, soft where you touch.** An active row is a flat plane with square corners; the avatar inside it has an eight-pixel radius. Mesh refuses to round a structural mark or to leave a touchable object square.
5. **State is readable without color.** Every colour carries a second channel: the trust rail pairs with a tooltip and an exception line, the avatar ring pairs with a footer legend and the visible identifier. Mesh refuses color-only selection, presence, speaking, warning, or error states.

## Positioning against Discord

Mesh keeps the left community rail, adjacent channel or conversation list, central message or call surface, optional right people pane, familiar composer placement, message actions, unread markers, and persistent call controls. A Discord user should know where to look without instruction.

Mesh deliberately differs in five ways:

- Home, Direct Messages, and community overviews use one editorial continuation target followed by a numbered ledger. This improves resumption instead of presenting an empty canvas.
- Surfaces are flat and share one ground. Rules and spacing explain structure; elevation is reserved for content that is actually overlaid.
- Federation and encryption state is ambient. A two-pixel trust rail in the timeline gutter, a ring on a mark whose owner is on another homeserver, and one caption per screen replace per-message protocol prose.
- Account-service choice is explicit, and invitations do not bind account hosting to community hosting. This is a product and trust improvement, not visual novelty.
- Voice remains visible through a persistent call bar after navigation. This makes an ongoing media state harder to lose.

The near-black ground, the mono micro-labels, and the numbered rows are visual character. They are intentionally different, but are not claimed as functional improvements.

## The shape of a room

A room can be read three ways on this device. A shape changes what the surface promises and nothing else: the same messages, the same membership, the same permissions, the same composer. It is not a room type on the wire, so declaring one cannot fail, cannot need a power level, and cannot desynchronise from the server. Nobody else's view changes.

| Shape | What it promises | Built from |
| --- | --- | --- |
| Conversation | The transcript, in order. The default, and never stored | The messages |
| Clips | A gallery, because in a room full of screenshots the picture is the content and the words are the caption | Messages the media classifier already recognises |
| Event | One answer pulled to the top: who is coming | The pinned message, and reactions on it |

Each shape is derived from something the room already has. An event's plan is the room's pinned message and its replies are reactions, so somebody reading that same room as a conversation sees a pinned plan with ticks on it, which is what a group does by hand anyway. A shape that needed its own wire format would be a room type, would need a power level, and would have a failure mode; none of these do.

The reply set is fixed at three, because a fourth option is a conversation and the room is already that. A chosen reply is marked by a bar and a fill, never by colour alone. `ClipsView.tsx` and `EventView.tsx` were not carried into the Quiet Structure pass and still use the prior geometry (`border-*-bar`); the behaviour they implement is unchanged.

## Typography

Two families, both vendored locally. Primary UI and editorial hierarchy use `Inter Variable` through `--font-sans`. `IBM Plex Mono` through `--font-mono` is limited to uppercase eyebrows, row numbers, chip labels, timestamps, keyboard hints, and machine values such as server names and latency. Prose is never mono, and Inter is never uppercased. Spline Sans is not part of this system.

Only weights 400, 500, and 600 are permitted. The scale is closed:

| Token | Size | Line height | Letter spacing | Use |
| --- | ---: | ---: | ---: | --- |
| `--font-size-2xs` | 11 px | 15 px | 0.05 em | Uppercase metadata and timestamps |
| `--font-size-xs` | 12 px | 1.33 | 0.005 em | Captions, status, secondary controls |
| `--font-size-code` / `--font-size-dense` | 13 px | 1.54 | 0 | Code and dense navigation |
| `--font-size-sm` | 14 px | 18 px | -0.01 em | Controls, navigation, secondary copy |
| `--font-size-base` | 15 px | 21 px | -0.005 em | Messages, forms, and body copy |
| `--font-size-md` | 18 px | 1.33 | -0.01 em | Section headings |
| `--font-size-title` | 22 px | 1.27 | -0.015 em | Route and modal titles |
| `--font-size-lg` | 28 px | 1.14 | -0.02 em | One primary editorial heading per surface |
| `--font-size-eyebrow` | 9.5 px | 1.5 | 0.16 em | Mono uppercase section label |
| `--font-size-count` | 10 px | 1 | 0 | Mono row numbers and badges |
| `--font-size-chip` | 10 px | 1 | 0.10 em | Mono plane-chip labels |
| `--font-size-support` | 12.5 px | 1.4 | 0.005 em | Descriptions and topics |
| `--font-size-row` | 13.5 px | 1.3 | -0.005 em | Room names and list rows |
| `--font-size-panel` | 15 px | 21 px | -0.015 em | Panel heads |
| `--font-size-section` | 30 px | 1 | -0.035 em | Section head |
| `--font-size-numeral` | 42 px | 1 | -0.05 em | Member counts and standalone numerals |
| `--font-size-screen-sm` | 46 px | 1 | -0.05 em | Secondary screen title |
| `--font-size-screen` | 56 px | 0.95 | -0.05 em | Screen title |
| `--font-size-display` | 76 px | 1 | -0.055 em | The one poster-scale heading in setup |

A grey that carries information must clear 4.5:1 on the ground. `--content-secondary` at 5.96:1 is the floor for any mono eyebrow, count, or caption; `--content-tertiary` at 4.00:1 is reserved for text at 18 px and above and for control boundaries.

Text must reflow at native 200 percent Windows text scaling without hiding controls, horizontal scrolling of prose, or loss of status. Truncation is allowed only when the full value is available through an accessible name or adjacent detail, and it is how the poster steps stay safe: `--text-scale` reaches 1.5, which puts the display step at 114 px, and `e2e/text-scale-reflow.spec.ts` measures that no heading exceeds its own box and no page scrolls sideways at 100, 125 and 150 percent across three window sizes.

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

## Spacing and density

The base spacing unit is 4 px. Permitted relationships are 4, 8, 12, 16, 20, 24, 32, and 40 px. Use 4 to bind icon and label, 8 for content within a compact control, 12 for a row, 16 for a component group, 20 or 24 for section rhythm, and 28, 32, or 40 only between major route regions. The conversation column uses 28 px of horizontal padding; a ledger row uses 8 px of vertical padding; the row-number gutter is 34 px.

`compact`, `default`, and `comfortable` change row padding, panel gaps, and line height through `--density-*`. They do not remove labels, focus indicators, or status. Interactive controls remain at least 32 px high in every density. Primary touch targets use 40 to 48 px where space permits.

## Color system

Color has three tiers:

1. Reference tokens, `--ref-*`, hold literal values only.
2. Semantic tokens name purpose, such as `--surface-base`, `--content-secondary`, `--status-danger`, and `--border-focus`.
3. Component tokens may narrow a semantic role, such as `--accent-container-line`; they may not contain new literals.

A new color enters only at the reference tier and must be consumed through a semantic name before a component uses it. Components and Tailwind configuration never use hex, numeric RGB, OKLCH literals, stock palette classes, or reference tokens directly.

The structural vocabulary above the ground is alpha-white rather than a set of surfaces: a pane rule at 0.08, a row separator at 0.045, and a fill at 0.05 that serves avatar tiles, input grounds, and hovered rows alike. None of the three is a control boundary -- at 1.19:1 and below they are decorative under WCAG 1.4.11, and `--border-control` is a separately measured value that clears 3:1. The rail is not a darker surface than the canvas; both are the same ground and a rule divides them.

Light and dark are independently specified complete themes. Alpha-white has no valid light-theme equivalent and is re-derived as alpha-black against the light canvas rather than flipped. High contrast is a complete functional theme, not an inversion. Every text and control pairing must meet WCAG AA: 4.5:1 for normal text and 3:1 for large text, focus indicators, rules that convey state, and non-text controls. Selection, presence, speaking, warning, and failure always include a non-color cue.

## Elevation, radius, and border

`--elev-card` and `--elev-inset` are `none`. `--elev-overlay` is permitted only for a dropdown, popover, modal, menu, or detached command surface that visually covers other content. A component in normal document flow uses rules and surface tokens, not shadow. A plane chip has no ledge: Quiet Structure has no elevation language, so a press changes the face rather than revealing a shadow beneath it.

The radius split is the design. Things you touch get a radius: `--radius-control` and `--radius-tile` at 8 px, `--radius-rail-item` at 9 px, `--radius-segment` at 7 px, `--radius-stage` at 12 px, `--radius-panel` at 14 px. Things that structure do not: `--radius-plane` is 0, and it is what an active row, a chip inside a rule, and a segmented selection use. Rules are always 1 px, with the trust rail the single 2 px exception. Status borders use at least `--border-width-status`; focus uses a 2 px explicit outline with a 2 px offset and never becomes the accent.

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

- **The trust rail.** A 2 px vertical bar in the timeline gutter spanning the full height of a message group: `--status-success` at 0.5 for a local, decrypted event from a verified device; `--status-warning` at 0.5 for a sender on another homeserver; `--status-danger` at 0.55 for an undecryptable event or an unverified device. Full server and key detail belongs in a hover tooltip and appears nowhere else.
- **The ring on the mark.** An avatar whose owner is on a different homeserver carries a 1 px chrome ring. This works in member lists, conversation lists, palette results, and the voice roster, where there is no gutter to carry a rail. Every surface that uses rings carries one legend line in its footer.
- **One ambient line per screen.** A single 11 px caption pinned to the bottom rule. Never one per message.

Only a departure from the norm gains words, as a mono line directly under the message body paired with a dot in the same tone. Per-message encryption labels, per-message origin-server labels, composer encryption strips, and padlock iconography are prohibited. The shell-level connection band is retained: a degraded link is an exception and has earned its words.

## Iconography

All UI icons route through `src/components/ui/Icon.tsx` and Lucide. Sizes are 14 px `xs`, 16 px `sm`, 18 px `md`, and 24 px `lg`. Stroke is 1.5 px, or 1.75 px for `lg`, with absolute stroke width. Icons align to the text cap-height or the center of a square control; they do not receive arbitrary offsets.

An icon may appear without a visible label only when the action is conventional in context and the control has a precise accessible name. Ambiguous actions, destructive actions, onboarding choices, call state, and errors keep visible text. Decorative icons are hidden from assistive technology.

## Component anatomy and states

Every interactive component has an authored focus-visible state. Browser-default focus alone does not conform. `disabled` suppresses activation but retains enough contrast to explain the control; `loading` preserves geometry and names the process; `error` names what happened and the next action.

| Surface | Anatomy | State contract |
| --- | --- | --- |
| Message row | Avatar gutter, author and time metadata, reply context, content, attachments, reactions, contextual actions | Default is flat; hover reveals actions without moving content; focus-visible outlines the active action; selected or targeted adds border plus text cue; disabled actions remain named; loading preserves row position; error is inline and retryable |
| Composer | Attachment action, labelled editor, formatting affordance, send action, upload and reply context | Focus-within receives the authored accent outline; active send has text/icon state; disabled explains why; loading keeps draft visible; send error preserves the draft and provides retry |
| Channel list item | Type icon, name, optional unread count, live state | Hover changes surface; focus-visible outlines the row; active and selected use position or border plus label treatment; disabled retains the name; loading uses stable rows; error stays scoped to the list |
| Community rail item | Real community or product asset, unread state, accessible name | Rest and selected geometry stay square; hover and focus are distinct; selected has a marker plus accessible state; loading never substitutes a fake asset; error exposes recovery text |
| Member row | Avatar, display name, optional handle, role or presence, call state | Presence and speaking pair color with text/icon/border; focus reveals permitted action; selected and disabled remain readable; loading and error do not reorder the list |
| Modal | Labelled title, concise consequence or task, content, ordered actions | Opens above an overlay with trapped focus; initial focus is safe; Escape and cancel restore focus; destructive confirmation is explicit; loading locks duplicate submission; error stays inside the modal |
| Toast | Status icon, short message, optional one-step action, dismiss | Uses `role=status` or alert semantics appropriate to urgency; never carries a multi-step task; hover pauses dismissal; focus reaches the action; error states name recovery |
| Empty state | Plain heading, reason, one obvious action, optional secondary guidance | No decorative card stack; focus begins at the heading or action; loading is not shown as empty; error uses the error-state anatomy |
| Error state | What failed, user impact, next action, optional reviewed details | Danger color is paired with icon/text; retry is focusable; raw protocol detail stays behind an explicit disclosure; disabled retry explains its condition |
| Call tile | Media or avatar, participant name, self marker, mute state, speaking state, connection state | Hover may reveal local controls; focus-visible outlines the tile/control; speaking uses border plus text; selected means locally focused; disabled controls remain named; reconnecting and error preserve identity and provide status |

## Voice and video

Voice is a primary route, not an overlay-only utility. Joining is one action. Messages remain reachable during a call.

- A call tile keeps the participant name and audible state visible over media. Camera-off uses the real avatar, not a placeholder illustration.
- Speaking uses a status-success edge or outline plus the word `Speaking` or `Talking`. Muted, listening, reconnecting, and disconnected are distinct text/icon states.
- With 2 participants, use two equal tiles. With 3, feature the active speaker across the first row and place two equal tiles below. With 4 to 8, use a responsive grid with no tile smaller than the useful name and status overlay; at 8, use four columns by two rows at 1280 by 720 and reduce columns before shrinking readable content.
- The active speaker may be featured, but every participant remains visible without opening a secondary panel for groups of eight or fewer.
- The persistent call bar remains in the application shell after navigation. It names the room, connection state, participant count, mute state, deafen state, leave action, and one action to return to the call. Compact layouts may hide redundant visible labels but retain accessible names and state.

## Mechanical enforcement

`scripts/check-design-tokens.mjs` enforces the closed typography, local font ownership, theme and density selectors, minimum controls, token-only component colors, semantic contrast pairs, geometry, elevation, motion values, reduced-motion support, central icon path, call-state hooks, and this document's required sections. It additionally asserts that the rail resolves to the same ground as the canvas, that the four structural alpha strengths keep their values, and that Spline Sans is not restored. Visual review enforces hierarchy, anatomy, responsive composition, and whether a screenshot satisfies the five principles.

## Budget decision

Quiet Structure reuses the existing token architecture and consolidated shared rules rather than introducing a second styling approach. The last measurement of the Matrix voice production build was taken under Indie Workshop, at 90.46 KiB raw CSS and 17.87 KiB compressed against the original 100 KiB raw ceiling. That figure predates this contract and is not a claim about the current artifact: the ceiling is unchanged, and `check:bundle-size` re-measures `dist/` on the next build.

Pixel-art masks are emitted as cacheable files instead of base64 stylesheet data. Lightning CSS performs behavior-preserving minification, and a tested PostCSS liveness pass removes source tokens that no compiled rule or renderer source can consume while preserving the complete source design contract. No ceiling increase or waiver is requested.

The 79 ms median and 355 ms observed p95 recorded for the optimized production preview were measured under the previous contract and are carried here as the figure to beat, not as a current result. That measurement isolates the web production surface in any case, not native process launch or a signed installed build, and signed installed-build acceptance remains a separate release gate.
