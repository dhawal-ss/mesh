# Mesh production-readiness continuation

> **ARCHIVED 2026-08-01 SNAPSHOT.** This is historical evidence, not a current
> readiness assertion. Current source and the schema-v2 readiness ledger win;
> rerun every named gate before reusing any count, SHA, or completion claim.

Status: `ALL_LOCALLY_SPECIFIABLE_FINDINGS_COMPLETE_NOT_RELEASE_READY`

Date: 2026-08-01

This tranche starts every locally actionable workstream from the production
audit without claiming that local evidence is production acceptance. It did
not stage, commit, push, deploy, sign, publish, provision, or enable voice.

## Implemented foundation

| Workstream | Result |
| --- | --- |
| Beta scope | Added `mesh/release/beta-contract.json` and checks that define a Windows Matrix text/community developer preview. Voice, legacy P2P, and automatic updates are excluded. |
| Account onboarding | Browser sign-in now explains why it is disabled outside the installed app while leaving supported password sign-in usable. Account-service selection remains explicit. |
| Release-honest product copy | Removed the unsupported voice promise from the default onboarding value proposition. A regression assertion now keeps the account-service screen aligned with the text/community beta contract. |
| Honest preview state | `?dev=workspace` no longer pretends voice is connected. Voice simulation requires the explicit `simulateVoice=true` query. |
| Voice artifact boundary | Added a separate `matrix-voice` acceptance build. The public Matrix build aliases the media module to a fail-closed stub and contains no LiveKit client, LiveKit E2EE worker, or SimplePeer asset. |
| Bundle control | Reduced the Matrix bundle to 1,112.08 KiB JavaScript and 1,544.89 KiB total assets. Tightened the respective limits to 1,400 KiB and 1,800 KiB. |
| Native least authority | Tauri now builds an explicit application-command manifest and grants the main WebView one reviewed `mesh-main` permission inventory. The drift checker binds 167 frontend/handler/permission commands. |
| Crash diagnostics | Added one bounded, local-only crash marker. It contains version/platform/source-basename metadata and omits payloads, backtraces, identifiers, content, arguments, and full paths. Nothing uploads automatically. |
| Operations | Added checked observability, incident-response, and trust-and-safety contracts plus public report/appeal/support routing. |
| Sync and scale | Added a benchmark-first decision record for classic `/sync` versus an SDK-supported successor. It prohibits a migration that loses interoperability, encryption correctness, or custom-service support. |
| Homeserver | Updated every checked Synapse Compose/setup/restore pin from v1.157.0 to v1.157.1 at multi-architecture index digest `sha256:d1fce43d7501428c461f2758dc10342555b946dc9f1d03c1b1b8aec1a4e8d130`. |
| Restore portability | Added one Docker-path boundary for Git Bash/MSYS. Windows bind sources are normalized without rewriting container paths; Linux and macOS keep native POSIX behavior and ownership enforcement. |
| Release enforcement | CI, the candidate workflow, source preflight, public-site checks, MatrixRTC preflight, and a new operations-contract checker enforce these boundaries. |

## Local verification

| Gate | Result |
| --- | --- |
| Frontend unit/component tests | 774 passed |
| Runtime product audit | The account-service choice, Matrix.org sign-in, custom-service sign-in, authenticated workspace, and fail-closed voice entry were exercised in the in-app browser at 1280x720. The unsupported onboarding voice claim was corrected; the voice entry kept microphone, camera, and screen off and explained the verification blocker. |
| Chromium E2E and automated WCAG scenarios | 67 passed |
| Matrix Rust feature | 195 executed tests passed; external live cases remain ignored by contract |
| Legacy/LAN Rust feature | 232 executed tests passed; external network/soak cases remain ignored by contract |
| Dedicated security invariants | Matrix 19/19; legacy 13/13 |
| Rust lint/format | Matrix and legacy Clippy passed with warnings denied; `cargo fmt --check` passed after formatting |
| Tauri IPC contract | 167 commands; explicit renderer permission active |
| Homeserver daemon-free tests | 24 Python tests, backup integrity regressions, operational-health portability regressions, and ShellCheck v0.10.0 passed; Compose source and example environment rendered successfully |
| Disposable Matrix federation | Two independent Synapse v1.157.1 reset/test cycles passed 2/2 each (197.32 s and 197.38 s). They exercised encrypted cross-server federation, privacy signals, directory/knock, community/channel state, presence, media/reactions/pins, offline replay, recovery, DMs, room upgrade, account data, moderation, and registration. Cleanup left zero containers and no disposable homeserver databases. |
| Disposable backup/restore | Two independent final cycles passed (32.8 s and 30.3 s), including manifest tamper rejection, backup verification, PostgreSQL restore with one-time-key data excluded, required-table checks, isolated Synapse health, isolated synthetic status, and zero leaked containers, networks, or volumes. This is local integration evidence, not an external operator recovery exercise. |
| Public-service checks | Matrix.org, tchncs.de, and quassel.io discovery/version/login checks passed live |
| Dependency policy | npm: 0 vulnerabilities. Shipping Matrix Rust graph: 0 known vulnerabilities and 7 reviewed warnings. The two Hickory RustSec findings remain visible only in the excluded legacy graph. |
| MatrixRTC configuration | Static preflight passed, including separation of the text beta and physical voice-acceptance build. No live voice evidence was collected. |
| Final frontend artifact | Entry 227.32 KiB; eager JS 446.68 KiB; all JS 1,112.08 KiB; assets 1,544.89 KiB; forbidden media/P2P assets absent |
| Native local artifacts | Release-profile child builds completed after their wrappers timed out and produced fresh unsigned artifacts. `mesh.exe`: `AEA7521E0DCC7EBEB651E4A5358257A8892565C27BF7DA0CADFC01184016AD21`; MSI: `75EBB6ABE0DFE4475053B67E79EC160B6403276DE6F927D02864857B7BE54B75`; NSIS: `E827E43EDC76F16808ACE026A3E326248FF26B1A49753007066C628358A41B9A`. The final integrity check found no orphaned build process, but neither wrapper captured a zero exit before its bound. Protected clean same-SHA CI remains authoritative. |

## Runtime UX audit

| Journey step | Health | Evidence-backed result |
| --- | --- | --- |
| Choose an account service | Healthy after correction | Matrix.org is prominent but explicitly independent; terms, privacy, more reviewed services, and custom service remain visible. The value proposition no longer promises voice in the text-only beta. |
| Sign in to Matrix.org | Healthy with a viewport caveat | Service reachability and supported methods are explained before credentials. Secondary browser-sign-in/help actions sit below the fold at 1280x720, while the primary password path remains visible. |
| Use another service | Healthy | The compatible-service address and Matrix ID stay first-class, with a capability check and no forced Mesh-operated service. |
| Enter a workspace | Healthy for text/community preview | Community, room, encryption, member, composer, and context hierarchy are legible and familiar. |
| Open a voice room | Correctly blocked | Mesh presents an unavailable state, names the private-media verification failure, and states that microphone, camera, and screen remain off. |

Automated semantics exposed named navigation, tablists, rooms, main conversation,
composer controls, room context, and the voice-unavailable region. This browser
audit is not a substitute for manual keyboard, screen-reader, zoom/reflow, or
installed-WebView assistive-technology acceptance.

## Honest blockers

1. The source tree is intentionally dirty and mixes pre-existing user work with
   this tranche. Clean-source and exact-SHA evidence cannot exist until the
   owner reviews and records the desired source on protected `main`.
2. Version `0.1.0` is a release-blocked placeholder. The fresh native artifacts
   are unsigned local evidence, not installable consumer releases.
3. Signing, protected same-SHA CI, clean-device Windows install/uninstall,
   automatic-update/rollback design, legal approval, public download checks,
   online operator smoke, two independent external operator recovery exercises,
   and the 58-case external acceptance campaign remain external owner/operator
   work. The two passing local disposable restore cycles do not satisfy that
   disaster-recovery gate.
4. MatrixRTC remains unavailable pending all 23 physical-device/network/media
   cases, real SFU/TURN conditions, media-E2EE approval, and release approval.
5. macOS and Linux remain acceptance-pending and are not supported release
   claims. iOS, Android, and web remain outside this candidate.

## Required next execution order

1. Review the dirty tree and decide which combined changes belong on protected
   `main`. Do not create release evidence from this mixed source state.
2. From the approved clean exact SHA, run protected CI and create a non-placeholder
   versioned, signed draft candidate. Do not promote it.
3. Run clean-device Windows, accessibility, provider lifecycle, online
   operations, two independent operator recovery exercises, public-download,
   signing, legal, and updater/rollback acceptance against that exact candidate.
4. Keep the public beta text/community-only. Run the separate `matrix-voice`
   build solely for the 23-case physical MatrixRTC campaign; enable voice only
   after the reviewed evidence and owner approval pass.

Production readiness remains fail-closed until every external gate is complete.
