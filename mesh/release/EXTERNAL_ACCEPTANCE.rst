External release acceptance
===========================

``external-acceptance.example.json`` is a fail-closed checklist. Copy it to an
operator-controlled location outside the source worktree, never edit the
tracked template to claim a pass, and never include access tokens, invitation
URLs, authorization headers, private keys, or unsanitized logs.

The 60 cases cover clean Windows installation, public release and signed
update delivery, provider identity lifecycle, optional community-hosted
operations (including two independent destructive restores), manual
accessibility, public-service re-review, and native invitation delivery on
macOS and Linux. The separate MatrixRTC evidence contract remains authoritative
for its 23 physical-device/media cases.

``acceptanceMilestone`` defines the support claim:

* ``R2`` requires the 52 Windows-beta and service/operations cases. It excludes
  VoiceOver, Orca, WKWebView, WebKitGTK, and ``native-invite.*`` because those
  are cross-platform support claims.
* ``R4`` additionally requires the four macOS/Linux accessibility combinations
  plus installed-protocol and cold-start invitation evidence on both platforms.
  Windows results can never satisfy those cases.

Each passed result needs a non-placeholder environment and at least one
sanitized artifact. Artifact/result links are bidirectional, and every file is
bound by byte size and SHA-256. The campaign uses one non-zero-major release
tag, exact source SHA, operator, test time, and expiry.

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

Promotion remains blocked on an owner-reviewed lifecycle decision. Do not add
or run a promotion path until the ordering for public prerelease verification,
canonical download routing, signed updater publication, rollback, legal
approval, and post-public live-download evidence is approved.
