# Quiet Structure conformance

Date: 2026-08-22  
Contract: `DESIGN_LANGUAGE.md`  
Source: `design_handoff_mesh_quiet_structure/README.md`, turn 6 (`#6a`–`#6f`) plus option `#5e`  
Status: implemented across all nine screens; two JavaScript budgets and the capture set remain

`Deferred` means the contract is satisfiable but the work is outstanding, and the row names what
closes it. `Release approval` means the source conforms locally but an owner or a physical
measurement is still required. `Owner decision` means a governed limit is exceeded and moving it is
not this change's to make. No implementation violation is intentionally waived.

## Handoff reconciliation

The handoff was written against a `--ref-werk-*` reference tier that has never existed in this
repository -- `git log -S 'ref-werk'` returns nothing. The shipped system was Indie Workshop
(`--ref-party-*`), so every "replaces" claim in the handoff maps onto the `--ref-party-*` token of
the same role, and the handoff's quoted *old* values (`#121316` canvas, `#F2F3F5` primary,
`#9BA0A8` secondary) are not this codebase's history. Its *new* values are authoritative and are
implemented exactly.

Two further deviations from the handoff, both deliberate and both stated by the handoff itself:

- **Production greys, not mock greys.** `#4A4C52` measures 2.31:1 on the ground and does not ship as
  text at all; `#6E7077` measures 4.00:1 and is reserved for text at 18 px and above and for control
  boundaries. Every mono eyebrow, count, and caption that carries information uses `#8B8D93`
  (5.96:1).
- **Icons are the lucide map**, not the mock's geometric stand-ins, per `Icon.tsx` and
  `scripts/check-icon-contract.mjs`.

## Conformance table

| Requirement | Status | Evidence | Result |
| --- | --- | --- | --- |
| Five falsifiable principles naming the ambient-federation stance | Conforms | `DESIGN_LANGUAGE.md` | The norm gets no words; only exceptions speak; structure is drawn; sharp where it structures; state is readable without color |
| Discord-familiar application anatomy | Conforms | `src/components/layout/AppLayout.tsx`; `src/components/layout/ChannelSidebar.tsx`; `src/components/community/MemberList.tsx` | Community rail, channel list, conversation, people pane, and composer retain familiar placement |
| Quiet Structure reference tier | Conforms | `src/styles/globals.css`; `scripts/check-design-tokens.mjs` | `--ref-quiet-*` carries the ground, the four content steps, the structural triad, and the four alpha strengths, asserted by value |
| One ground, rules instead of value steps | Conforms | `src/styles/globals.css`; `scripts/check-design-tokens.mjs` | The gate fails if `--surface-rail` ever resolves to something other than `--surface-canvas` |
| Structural hairlines are not control boundaries | Conforms | `src/styles/globals.css`; `scripts/check-container-contrast.mjs` | `--border-structural` (1.19:1) and `--border-row` (1.09:1) are decorative; `--border-control` is a separate value that clears 3:1 |
| Closed type scale extended with the Quiet Structure roles | Conforms | `src/styles/globals.css`; `tailwind.config.ts`; `scripts/check-design-tokens.mjs` | Twelve new named steps from 9.5 px eyebrow to 76 px display; each ships its own leading, and a fixed-rem `leading-*` beside one is rejected |
| Two families only | Conforms | `src/styles/globals.css`; `scripts/check-design-tokens.mjs` | Inter and IBM Plex Mono; the gate fails if Spline Sans is restored |
| Sharp/soft radius split | Conforms | `src/styles/globals.css`; `scripts/check-design-tokens.mjs` | `--radius-plane` is 0 for structural marks; touchable objects carry 7–14 px |
| Density remains accessible | Conforms | `src/styles/globals.css`; `scripts/check-design-tokens.mjs` | All density control tokens remain at least 32 px and do not remove focus or labels |
| Three-tier color system | Conforms | `src/styles/globals.css`; `tailwind.config.ts`; `scripts/check-design-tokens.mjs` | Literals are confined to the reference tier; components consume semantic or component roles |
| Complete dark, light, and high-contrast themes | Conforms | `src/styles/globals.css`; `scripts/check-container-contrast.mjs` | Alpha-white rules are re-derived as alpha-black on the light canvas and as full-strength rules in high contrast, not flipped |
| AA contrast and non-color state | Conforms | `scripts/check-design-tokens.mjs`; `scripts/check-container-contrast.mjs` | Every measured text pair and container line clears its minimum in all three themes with no accepted shortfalls |
| Flat hierarchy and semantic elevation | Conforms | `src/styles/globals.css`; `src/components/ui/Modal.tsx` | Flow content is shadowless; detached overlays alone use `--elev-overlay`; plane chips have no ledge |
| Causal motion and reduced-motion equivalent | Conforms | `src/lib/motion.ts`; `src/styles/globals.css`; `scripts/check-design-tokens.mjs` | Motion uses named offsets, durations, and easing; reduced motion preserves state, focus, and bounded progress |
| Central icon contract | Conforms | `src/components/ui/Icon.tsx`; `scripts/check-icon-contract.mjs` | Lucide icons use 14, 16, 18, or 24 px sizes with fixed optical stroke behavior |
| Token and visual-literal enforcement | Conforms | `scripts/check-design-tokens.mjs` | The checker rejects component literals, stock palette classes, reference-tier consumption, unsupported type, hardcoded visual geometry, and hardcoded motion |
| Trust derivations shared by every surface | Conforms | `src/lib/trust.ts`; `src/lib/trust.test.ts` | `serverRelation` fails closed and `eventTrust` ranks suspicion above origin; every rail, ring and caption reads them, so no two surfaces can disagree about one person |
| Quiet Structure primitives | Conforms | `src/components/ui/QuietStructure.tsx`; `src/components/ui/QuietStructure.test.tsx` | `Eyebrow`, `SegmentedControl`, `TrustRail`, `StateTick`, `ExceptionLine`, `AmbientNote` and `rowNumber`. `NumberedRow`, `PlaneChip`, `ScreenTitle` and `ProgressRule` were written and then removed: every screen that looked like it wanted one needed behaviour the primitive could not carry, and a component with no call site enforces nothing while still shipping |
| Capped shell grid | Conforms | `src/components/layout/AppLayout.tsx` | Three panes on one ground divided by `--border-structural`; the flex shell already carried `min-h-0` on every scroll region, so the grid-track collapse the handoff warns about cannot occur here |
| Conversation, home, DMs, settings, voice, sign in, onboarding, palette | Conforms | `ChatView.tsx`, `ChannelItem.tsx`, `Message.tsx`, `MessageInput.tsx`, `MemberList.tsx`, `RoomContextPanel.tsx`, `HomeSurface.tsx`, `DmSidebar.tsx`, `DmView.tsx`, `UserSettingsPanel.tsx`, `VoiceView.tsx`, `VoicePeerGrid.tsx`, `VoiceControls.tsx`, `MatrixAccountScreen.tsx`, `OnboardingFlow.tsx`, `IdentityScreen.tsx`, `InteractivePrimitives.tsx` | Each screen re-authored against `#5e`, `#4c`, `#6d`, `#6c`, `#6e`, `#6a`, `#6b`, `#6f` |
| No elevation language | Conforms | `src/styles/globals.css`; `src/components/ui/Button.tsx`; `src/components/ui/IconButton.tsx` | The accent ledge, the 1 px hover lift, the 1 px press dip and the rail icon scale are removed; a control changes its face on press and nothing moves |
| 1280 by 720 visual evidence | Conforms | `audit/design-2026-08-current/`; `e2e/capture-evidence.spec.ts` | Seven screens recaptured from the workspace preview by a spec that is kept, so the set regenerates rather than being reproduced by hand. See the screenshot index for the three that were deleted instead |
| Browser suite | Conforms | `e2e/` | All three Playwright projects pass: 83 in `chromium` including the axe WCAG A/AA sweeps, 1 in `chromium-performance`, and 8 in `chromium-lan`. The large-timeline budget holds with the deeper message row -- 10,000 messages, 34 rendered rows at peak, 1,451 DOM nodes, 3.5 MB of heap growth and no long tasks. Running any of it needed a dev server of this branch's own: the committed config binds 1420 with `reuseExistingServer`, and a server for a different checkout was already listening there |
| Compact height | Conforms | `src/styles/globals.css` | Below 640px of viewport height the room title steps down from the screen size to the section size and the header's block padding halves. At 500px the 112px header had starved the timeline to zero and the message feed measured hidden |
| Voice room and call bar evidence | Deferred | `e2e/capture-evidence.spec.ts` | `shouldExposeVoiceRoutes` gates the voice destinations on backend capabilities the preview mock does not report, so there is no path to a call in this fixture. Capturing them needs a real Matrix RTC session |
| Text scale reflow | Conforms | `e2e/text-scale-reflow.spec.ts` | The conversation and setup are measured at 100, 125 and 150 percent on 1280x720, 1100x700 and 800x600: no horizontal page scroll, no heading wider than its own box, and the composer still reachable. The poster steps truncate rather than push the layout sideways, which is why a 114 px display heading is safe. This is the in-app control, which is a different mechanism from browser zoom -- zoom scales the viewport, so the layout keeps its proportions and the reachability specs cover it |
| Native 200 percent Windows text | Release approval | none | The OS-level setting is not the in-app `--text-scale` and cannot be exercised from a browser runner. It remains a Track G physical acceptance item |
| Third-party notices | Deferred | `THIRD_PARTY_NOTICES.md` | The Spline Sans row was removed and the package count decremented by hand, because `generate-third-party-notices.mjs` walks `node_modules` and fails with ENOENT in a git worktree, where the dependency tree resolves to the parent repository. The gate should be run from a normal checkout before release |
| Raw CSS budget | Conforms | `scripts/check-bundle-size.mjs` | 114.09 KiB against the 115 KiB ceiling. The design pass first landed at 119.88 KiB; the ceiling held by removing the `--quiet-theme-*` alias tier, the elevation treatments, the unused faint step, two duplicate radii and two Tailwind content-scanner false positives |
| JavaScript budgets | Owner decision | `scripts/check-bundle-size.mjs` | Both were already breached at the merge base `3b93888`: eager JavaScript 551.29 KiB and all JavaScript 2197.99 KiB against ceilings of 548 KiB and 2176 KiB. This branch measures 554.77 KiB and 2207.04 KiB, so it adds 3.48 KiB and 9.05 KiB to an existing overrun. Raising an owner-governed ceiling is not this change's to make |
| Design-language approval | Release approval | `DESIGN_LANGUAGE.md` | The named contract exists and is testable; the owner must change its status to approved |

## Screenshot index

Captured at 1280 by 720 from the workspace preview by `e2e/capture-evidence.spec.ts`, which is kept
so the set regenerates rather than being reproduced by hand. Run it with `npm run e2e:evidence`; it
is excluded from the ordinary suite because it writes files, and it refuses to run against a server
that is not serving Quiet Structure -- the committed Playwright config reuses whatever is already
listening on its port, which is how a foreign checkout's design once ended up in this directory.

| State | Evidence |
| --- | --- |
| Home | `audit/design-2026-08-current/01-home-1280x720.png` |
| Community desk | `audit/design-2026-08-current/02-community-1280x720.png` |
| Direct Messages hub | `audit/design-2026-08-current/03-direct-messages-1280x720.png` |
| Conversation with room details | `audit/design-2026-08-current/04-private-conversation-1280x720.png` |
| Settings, Appearance | `audit/design-2026-08-current/05-settings-1280x720.png` |
| Account-service onboarding | `audit/design-2026-08-current/06-onboarding-1280x720.png` |
| Command palette | `audit/design-2026-08-current/10-command-palette-1280x720.png` |

Three captures from the previous set were deleted rather than kept: the voice room, the persistent
call bar, and the 200 percent layout equivalent. All three recorded the Indie Workshop contract, and
a governance document that cites a superseded screenshot as current evidence is worse than one that
cites none.

## Out of scope, carried from the handoff

- **Private conversation (DM detail)** and the **invitation confirmation** screen were not designed.
  They take the conversation spec (`#5e`) and the DM spec (`#6d`) respectively.
- **Light and high-contrast themes** were not designed. Both are kept complete and gate-green here; a
  deliberate visual pass on the light ground is a separate piece of work.
- **Server latency on sign in** is new product surface with no probe behind it. The service row ships
  without a latency tick rather than with a fabricated one.
- **Compact viewport** (`COMPACT_VIEWPORT_QUERY`) collapse rules for the 250 px list column and the
  226 px context panel are undesigned.

## Exit status

The token tier, the theme branches, the type scale, the geometry, all nine screens, and their
mechanical enforcement conform. The renderer suite, the design-token gate, the container-contrast
gate, the icon contract, the copy-style gate and the CSS budget are green.

One thing is not, and two are outstanding. The JavaScript budgets were breached before this work and
are breached by more after it; the row above states both numbers against the merge base so the size
of each can be seen separately, and neither ceiling has been moved. The voice room and call bar
cannot be captured from this fixture, and the third-party notices were hand-edited because their
generator cannot run in a worktree.

Native cold start on a signed installed build remains part of Track G physical acceptance and is not
implied by a local production-preview measurement.
