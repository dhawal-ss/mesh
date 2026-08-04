External release acceptance
===========================

``external-acceptance.example.json`` is a fail-closed checklist. Copy it to an
operator-controlled location outside the source worktree, never edit the
tracked template to claim a pass, and never include access tokens, invitation
URLs, authorization headers, private keys, or unsanitized logs.

The 62 cases cover clean Windows installation, cross-format replacement
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

* ``R2`` requires the 54 Windows-beta and service/operations cases. It excludes
  VoiceOver, Orca, WKWebView, WebKitGTK, and ``native-invite.*`` because those
  are cross-platform support claims.
* ``R4`` additionally requires the four macOS/Linux accessibility combinations
  plus installed-protocol and cold-start invitation evidence on both platforms.
  Windows results can never satisfy those cases.

Each passed result needs a non-placeholder environment and at least one
sanitized artifact. Artifact/result links are bidirectional, and every file is
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

Store the sanitized manifest in an immutable release or workflow artifact.
The readiness ledger can reference that HTTPS artifact plus its SHA-256; this
keeps post-run evidence bound to the tested source SHA without pretending the
evidence existed inside that source commit.

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
signing evidence, the required R2 or R4 campaign, and post-public live-download
verification. Rollback removes canonical pointers without reusing version or
tag bytes.
