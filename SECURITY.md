# Mesh security policy

## Supported versions

Mesh has not published a production beta. Only the latest source on the protected
`main` branch receives security fixes. Unsigned developer previews are not
supported consumer releases, and automatic updates remain disabled until a
signed public update route is verified.

## Report a vulnerability

**Confidential route status: unavailable.** GitHub private vulnerability
reporting is currently disabled for this repository, and no reviewed security
mailbox has been published. Do not open a public issue, discussion, pull request,
or advisory draft containing exploit details, account tokens, invitation
secrets, recovery material, personal data, signing material, or service
credentials. The production beta is blocked until the owner enables and drills a
confidential reporting route; this file and the public security page must be
updated in the same reviewed change when that happens.

Include the affected source SHA, operating system, impact, minimal reproduction,
and whether the issue may already have exposed data. Do not test against accounts,
communities, or infrastructure you do not own or have explicit permission to use.

Once a confidential route is enabled, the owner will acknowledge reports,
coordinate remediation and disclosure, and credit reporters when requested and
safe. No response-time SLA is promised before the production beta exists.

## Release security boundary

Consumer release artifacts are Matrix-only. The optional `legacy-p2p` engineering
feature is compiled and audited separately but must not enter release bundles or
release-readiness claims. A signed candidate may only be created as a protected
draft prerelease. Public promotion is a separate owner-controlled decision and
requires signed Windows artifacts, checksums, SBOMs, provenance, legal approval,
updater/rollback review, and public download verification. Passing local or
disposable CI tests is not production acceptance.
