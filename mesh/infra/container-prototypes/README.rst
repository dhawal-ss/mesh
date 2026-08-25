Local container security prototypes
===================================

This directory contains diagnostic, local-only image builds for evaluating a
possible Mesh-owned container supply chain. It does not change the images used
by Compose, protected CI, the beta release workflow, or the production
container policy.

The Caddy and ``lk-jwt-service`` builds bind upstream release source to exact
commit SHAs, use an exact Go builder image digest, and apply only the dependency
updates that pass their upstream tests and the current vulnerability scan. The
Caddy build checksum-verifies and applies the exact two-line compatibility
change from upstream pull request 7872 before using the patched ``cel-go`` API;
the patch is a first-class policy and provenance input. Their scratch
runtimes intentionally contain only the service binaries and required runtime
files, run under an explicit numeric non-root user and group, and enforce
reviewed commands, working directories, ports, and OCI labels. Each build also
proves that its upstream release tag resolves to the pinned commit.
The smoke path uses a read-only root filesystem, drops every Linux capability,
sets no-new-privileges, and gives Caddy only private ``0700`` temporary state.
The final scratch filesystem is exported and checked against reviewed
owner/mode entries; shells, package managers, source trees, and Git metadata are
forbidden. A hashed payload manifest is included as a provenance byproduct.
The pinned Syft output is also checked semantically: the complete component
count, service and integration modules, dependency overrides, image identity,
and absence of builder-only packages must match policy.
The pinned Grype scan rejects every fixable finding at every severity. Its
official vulnerability-database URL, URL-embedded SHA-256, schema, build time,
validity, 120-hour maximum age, and enabled hash/age validation are recorded in
the summary and bound into provenance without copying the machine-local cache
path.

Synapse remains blocked from becoming a Mesh-maintained candidate. Its current
release and development images have fixable findings, while the available fixes
require unsupported or prerelease Python and library combinations. There is
deliberately no Synapse Dockerfile here. Synapse is reference scoped rather than
a shipped client dependency, so protected CI records and publishes its findings
without suppressing them or failing the client-release gate. The one-command
prototype workflow still scans both exact image digests and requires each raw
artifact to reproduce all 62 fixable findings, including 32 High or Critical
findings, against the same validated database as the buildable prototypes. A
changed count is evidence drift that requires review, not a reason to weaken or
silently clear the finding.

Run the contract check from the application root::

  npm run check:container-supply-chain

Build, smoke-test, generate CycloneDX SBOMs, scan the local candidates, and
generate unsigned in-toto/SLSA provenance statements with one command::

  npm run container-prototypes:local

The bootstrap downloads only the policy-pinned official Windows AMD64 release
archives for Syft 1.50.0 and Grype 0.116.1. It verifies each archive and
executable SHA-256, then reuses the verified operating-system temporary cache.
For this local path, Docker's implicit volatile BuildKit attestation is disabled
and replaced by the explicit statement generated after the SBOM and scan. Each
image is built a second time and must reproduce the same local image ID.
To use separately provisioned binaries instead, run the lower-level command::

  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-local-container-prototypes.ps1 `
    -SyftPath C:\path\to\syft.exe `
    -GrypePath C:\path\to\grype.exe

Outputs go to a new operating-system temporary directory unless an explicit
output directory is supplied. The semantic evidence check binds each local
image digest to its exact upstream revision, builder digest, Docker context,
source patches, dependency overrides, scanner executables, vulnerability
database, SBOM, and scan.
These statements are deliberately unsigned. Runtime smoke checks include a
real HTTP request to the non-root Caddy container and the authorization service
health endpoint. The script never pushes, signs, deploys, or updates production
references. Local image success is not protected or release evidence.

Adoption requires an owner-approved registry and maintenance contract, a
protected multi-architecture build, digest-bound SBOM and provenance artifacts,
keyless GitHub OIDC signatures, the full required infrastructure regression
campaign, and a fresh exact-candidate security manifest. MatrixRTC additionally
requires the complete physical acceptance campaign; ``voiceReady`` remains
false.
