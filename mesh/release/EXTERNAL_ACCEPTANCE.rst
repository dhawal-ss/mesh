External release acceptance
===========================

``external-acceptance.example.json`` is a fail-closed checklist. Copy it to an
operator-controlled location outside the source worktree, never edit the
tracked template to claim a pass, and never include access tokens, invitation
URLs, authorization headers, private keys, or unsanitized logs.

The 63 cases cover clean Windows installation, cross-format replacement
blocking and guidance, public release and updater-disabled controls, provider
identity lifecycle, optional community-hosted operations (including two
independent destructive restores), manual accessibility, public-service
re-review, and native invitation delivery on macOS and Linux. The separate
MatrixRTC evidence contract remains authoritative for its 23
physical-device/media cases.

The first beta has no automatic updater. For R2, ``windows.update`` means a
manual signed-installer upgrade that preserves the account and resumes safely.
``public-release.updater-manifest`` passes only when the candidate exposes no
updater manifest, endpoint, plugin, or background check.
``public-release.updater-rollback`` passes only when rollback withdraws
canonical download pointers and documents a manually installed signed
replacement without reusing version or tag bytes. These are negative controls;
they must never be satisfied by publishing an updater for the first beta.

``acceptanceMilestone`` defines the support claim:

* ``R2`` requires the 55 Windows-beta and service/operations cases. It excludes
  VoiceOver, Orca, WKWebView, WebKitGTK, and ``native-invite.*`` because those
  are cross-platform support claims.
* ``R4`` additionally requires the four macOS/Linux accessibility combinations
  plus installed-protocol and cold-start invitation evidence on both platforms.
  Windows results can never satisfy those cases.

Each passed result needs a non-placeholder environment and at least one
artifact explicitly marked as sanitized; live validation rejects evidence
marked unsanitized even when automated content inspection finds no known
secret pattern. Images, PDFs, and video also require a named human privacy
reviewer because compressed visual content cannot be reliably inspected as
plain text. Artifact/result links are bidirectional, and every file is
bound by byte size and SHA-256. The campaign uses the exact release tag approved
in ``owner-decisions.json``, exact source SHA, operator, test time, and expiry.

Validate the tracked contract without making a live claim::

  node --test scripts/check-external-acceptance.test.mjs
  node scripts/check-external-acceptance.mjs

Validate completed live evidence from a clean exact-SHA checkout::

  node scripts/check-external-acceptance.mjs `
    --file X:\operator\external-acceptance.json `
    --evidence-root X:\operator\external-acceptance-evidence `
    --commit-sha <40-character-source-sha> `
    --require-live

Store the sanitized manifest as the single root-level
``external-acceptance.json`` file in an immutable protected CI artifact. The
readiness ledger must reference the canonical GitHub Actions artifact URL, ZIP
SHA-256, and exact workflow run attempt. R2 validation downloads the bounded
archive, proves it came from the successful ``CI`` workflow on a ``main`` push
for the tested source SHA, safely extracts the single JSON document, and reruns
the live 55-case validator. A release asset or arbitrary HTTPS URL is not
protected acceptance evidence. Until a reviewed protected evidence-ingestion
job exists, R2 remains blocked rather than accepting manually asserted URLs.

The R2 install, account, messaging, and accessibility campaign stays runnable
when voice infrastructure is unavailable, but R2 alone cannot authorize the
public beta. Run the production operator smoke with ``-Milestone R2`` and omit
the four MatrixRTC, SFU, and TURN settings from that operator-owned
configuration. Before promotion, run the separate ``-Milestone R3`` voice
campaign; that mode requires and tests those settings::

  Copy-Item infra/operator-smoke/r2.env.example X:\operator\operator-smoke-r2.env
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/operator-smoke.ps1 `
    -Production -Online -Milestone R2 `
    -EnvironmentFile X:\operator\operator-smoke-r2.env

  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/operator-smoke.ps1 `
    -Production -Online -Milestone R3 `
    -EnvironmentFile X:\operator\operator-smoke-r3.env

Verify provenance before installation
-------------------------------------

From a clean directory, download the candidate installer and its checksum file,
verify the published SHA-256, and then verify the GitHub artifact attestation::

  gh attestation verify .\Mesh_<version>_x64-setup.exe --repo dhawal-ss/mesh
  gh attestation verify .\Mesh_<version>_x64_en-US.msi --repo dhawal-ss/mesh

The attestation subject digest must match the downloaded file and the workflow
must identify the expected ``dhawal-ss/mesh`` repository. This provenance check
is in addition to, not a replacement for, the Authenticode signer and trusted
timestamp checks. Record the command output as sanitized acceptance evidence;
do not paste environment variables or authentication headers into it.

Candidate and promotion lifecycle
---------------------------------

``release-beta.yml`` is candidate-only. It may use the protected signing
environment to create a signed **draft prerelease** after clean exact-SHA R0
gates pass. It cannot publish or promote the draft. This ordering is required
because clean-device, provider, accessibility, updater, and public-download
acceptance need a signed candidate before they can be collected.

The owner-approved first-beta lifecycle keeps the release as a draft prerelease
until acceptance is complete, promotes NSIS as the canonical consumer download,
keeps MSI as a secondary managed-deployment artifact, and keeps automatic
updates disabled. Promotion still requires exact-version legal approval,
signing evidence, the complete R2 and R3 campaigns, and post-public
live-download verification. R4 becomes mandatory before adding macOS or Linux
support. Rollback removes canonical pointers without reusing version or tag
bytes.
