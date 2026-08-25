Mesh Windows performance and accessibility acceptance
=====================================================

Purpose
-------

This runbook produces physical evidence from one clean, signed, exact-source
Windows candidate. Local browser evidence can catch regressions, but it cannot
promote a production gate.

Required equipment
------------------

* A clean Windows 11 machine representative of the beta floor.
* The protected, Authenticode-signed Mesh candidate and its exact source SHA.
* Current WebView2 and NVDA.
* A physical keyboard, speakers or headphones, and a Windows contrast theme.
* Accounts on two independent compatible account providers. One may be
  Matrix.org and one may be a reviewed community-hosted service.
* A room containing 10,000 representative messages for the physical scroll
  trace, plus a real MatrixRTC room when voice is authorized.

Hard stops
----------

Stop and retain the failing evidence if the candidate is unsigned, the source
SHA is not exact, the worktree is dirty, any tool targets a different
executable, either provider is unhealthy before the run, or the physical
candidate differs between tests. Never convert local preview results into
signed-candidate evidence.

Installed cold start
--------------------

Run at least ten launches. The probe waits for an enabled UI Automation control,
not merely a process or window. For an authenticated account, pass the exact
accessible name of a stable first action.

::

  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/installed-startup-probe.ps1 `
    -CandidatePath "C:\Program Files\Mesh\Mesh.exe" `
    -OutputFile "evidence\windows\startup.json" `
    -Runs 10 `
    -ReadyAutomationName "Direct messages","Open an invitation"

Acceptance is p95 at or below 2,000 ms with all ten runs present. Record cold
and warm operating-system cache conditions in the evidence notes if they differ.

Idle and loaded resources
-------------------------

Leave the foreground candidate untouched for five minutes, then capture at
least five minutes. Repeat with the 10,000-message room loaded. When real voice
is authorized, repeat in a real active voice room.

::

  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/resource-budget-probe.ps1 `
    -Scenario idle-text-sync -ProcessId <mesh-process-id> `
    -OutputFile "evidence\windows\idle-text-sync.json" `
    -SettlingSeconds 300 -SampleSeconds 300 -BuildType installed-release

  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/resource-budget-probe.ps1 `
    -Scenario active-voice -ProcessId <mesh-process-id> `
    -OutputFile "evidence\windows\active-voice.json" `
    -SettlingSeconds 300 -SampleSeconds 300 -BuildType installed-release

Targets are idle CPU median below 1 percent, idle CPU p95 below 2 percent,
idle working set at or below the provisional 150 MiB ceiling, and loaded
working set at or below the provisional 300 MiB ceiling. Active voice retains
the existing below-2-percent idle CPU requirement. ETW/WPA is still required
for authoritative wakeup and physical 60 fps evidence.

Ten-thousand-message scroll
---------------------------

First run the deterministic local fixture to catch virtualization regressions:

::

  npm run e2e:large-timeline

It records DOM, heap, long-task, and frame-interval evidence in
``test-results/large-timeline-performance.json``. This fixture is not physical
release evidence. On the signed candidate, record an ETW/WPA or equivalent
frame trace while scrolling the real 10,000-message room from first to last and
back. Retain raw trace, median, p95, worst frame time, sustained frame rate,
working-set peak, candidate hash, source SHA, machine, and display refresh rate.
The release target is sustained 60 fps.

Message delivery against two providers
--------------------------------------

Open a healthy room, keep Mesh focused, and run the probe once per independent
provider. The composer name is its visible accessible name, such as
``Message general`` or ``Message Maya Chen``.

::

  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/message-latency-probe.ps1 `
    -ProcessId <mesh-process-id> -ProviderLabel "Matrix.org" `
    -RoomLabel "latency-room-a" -ComposerAutomationName "Message general" `
    -OutputFile "evidence\windows\latency-matrix-org.json" -Samples 10

  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/message-latency-probe.ps1 `
    -ProcessId <mesh-process-id> -ProviderLabel "Reviewed provider B" `
    -RoomLabel "latency-room-b" -ComposerAutomationName "Message general" `
    -OutputFile "evidence\windows\latency-provider-b.json" -Samples 10

The probe measures optimistic-row visibility and the transition out of the
sending state. Each provider must have at least ten samples, optimistic p95 at
or below 100 ms, and confirmed p95 at or below 1,000 ms. A delayed or degraded
provider run is retained separately and must not replace the healthy baseline.

Manual accessibility
--------------------

Copy ``infra/windows-acceptance/accessibility-checklist.example.json`` into the
protected evidence directory. Fill candidate, WebView2, Windows, NVDA, tester,
hardware, time, per-case status, notes, and sanitized artifact paths. Complete
all five cases on the same signed candidate:

1. Full keyboard-only onboarding, invitation, messaging, settings, and sign-out.
2. NVDA browse and focus-mode reading plus live updates and errors.
3. Native 200 percent scaling and text size across primary journeys.
4. Windows high contrast with visible focus and non-color state equivalents.
5. Windows reduced motion across navigation, dialogs, messages, and voice.

Any failure remains a blocker. Automated axe, narrow-viewport, forced-colors,
and reduced-motion checks are supporting evidence only.
