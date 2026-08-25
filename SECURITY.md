# Mesh security policy

## Supported versions

Mesh has not published a production beta. Only the latest source on the protected
`main` branch receives security fixes. Unsigned developer previews are not
supported consumer releases, and automatic updates remain disabled until a
signed public update route is verified.

## Report a vulnerability

**Confidential route status: enabled.** Report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/dhawal-ss/mesh/security/advisories/new).
Do not open a public issue, discussion, pull request, or advisory draft
containing exploit details, account tokens, invitation secrets, recovery
material, personal data, signing material, or service credentials.

Include the affected source SHA, operating system, impact, minimal reproduction,
and whether the issue may already have exposed data. Do not test against accounts,
communities, or infrastructure you do not own or have explicit permission to use.

The repository owner acknowledges reports, coordinates remediation and
disclosure, and credits reporters when requested and safe. No response-time
SLA is promised before the production beta exists.

## Release security boundary

Consumer release artifacts are Matrix-only. The optional `legacy-p2p` engineering
feature is compiled and audited separately but must not enter release bundles or
release-readiness claims. A signed candidate may only be created as a protected
draft prerelease. Public promotion is a separate owner-controlled decision and
requires reviewed artifacts for Windows, macOS, and Linux together (signed and
timestamped on Windows; unsigned, unnotarized third-party software on macOS per
D22; unsigned on Linux), checksums, SBOMs, provenance, legal approval,
updater/rollback review, and public download verification on every supported
platform. Passing local or disposable CI tests is not production acceptance.

## Desktop content policy

Release windows enable Tauri content protection and both desktop policies deny
objects, document base URLs, form submissions, and framing. The remaining
`style-src 'unsafe-inline'` exception is intentional for the current React and
Tauri renderer: removing it requires replacing runtime inline style values and
visually revalidating every supported state. It permits CSS declarations, not
scripts, and must not be broadened to `script-src`.
