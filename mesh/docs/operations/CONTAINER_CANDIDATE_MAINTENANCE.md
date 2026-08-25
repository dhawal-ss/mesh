# Mesh container candidate maintenance

## Scope

Mesh maintains hardened candidate images for Caddy and `lk-jwt-service` in the
public GitHub Container Registry. This is a zero-cost release dependency for
the optional community service and voice authorization paths. It does not make
Mesh an account provider and does not change the default account-service
choice.

Synapse is not covered by a Mesh-maintained image. Its current supported stack
still has fixable High and Critical findings. It is an upstream reference image,
not a shipped or Mesh-routed dependency, so the findings remain scanned,
published, and disclosed without failing the client-release gate. A community
owner must review that evidence before using the optional reference deployment.

The machine-enforced cadence, expiry, ownership, rotation, deprecation, and tag
immutability contract is ``infra/REGISTRY_MAINTENANCE.md``. This document is an
operational summary and cannot override that control.

## Build and trust contract

The candidate policy binds every maintained image to an upstream release tag
and commit, pinned builder, Linux AMD64 and ARM64 index, non-root scratch
runtime, CycloneDX SBOM, zero-fixable-High-or-Critical scan, keyless signature,
and registry provenance. Ordinary workflow runs verify those exact published
bytes and evidence; they have no package-write permission.

The checked-in workflow is permanently read-only. It has no publication input,
package-write permission, registry login, image build, tag creation, signing,
or attestation authority. Its manual dispatch performs the same exact-policy
verification as push and schedule runs.

Every future publication requires a separate protected-branch source review
that fixes the exact evidence-backed source, unused target, and digest; adds
strict target-absence and evidence gates; isolates the minimal write job; and
updates both fail-closed validators and their negative tests. Arbitrary
selectors remain forbidden. After one authorized use, all temporary mutation
authority must be removed immediately and the permanent read-only checks must
pass before the rotation is complete.

Candidate packages must be public. A private package is not eligible for a
Compose or release-policy pin because community operators must not need a Mesh
credential to retrieve an optional service image.

## Maintenance response

- Pushes, scheduled maintenance, and ordinary manual runs only scan and verify
  the policy-pinned exact digest. They do not build, push, sign, attest, or
  change a registry tag.
- The permanent workflow cannot publish. A temporary publication input may
  exist only in a protected, reviewed fixed-source change and must be retired
  immediately after one use. Release tags are immutable after creation.
- A fixable High or Critical finding blocks the candidate immediately. Begin a
  dependency update or rebuild within 24 hours.
- Review an unfixed Critical finding within 24 hours. Do not add an exception
  without an exact digest, vulnerability, applicability analysis, reviewer,
  and expiry.
- Every replacement repeats source-tag binding, upstream tests, multi-platform
  build, runtime smoke tests, SBOM generation, zero-finding scan, signature,
  provenance, disposable federation, backup, restore, health, and cleanup.
- Retain the previous digest until the replacement completes its regressions,
  then remove it from deployment references. Do not delete historical evidence.

## Resolved 2026-08-10 tag incident

Run `31439670038` failed closed before write because its digest-only source did
not match the exact policy and SBOM identity. Run `31440088902` subsequently
verified the exact source, fresh scan, signature, CycloneDX, provenance, and
evidence, then created unused tag `0.5.0-mesh.2` at the reviewed digest. Its
only failure occurred in post-create display parsing after the tag existed, so
the run was not retried. The reviewed one-use fix was corrected to capture
complete `imagetools` output before extracting the digest, then retired with
the one-shot input and jobs. The checked-in workflow now has zero mutation
authority. Active policy and R3 voice references have rotated to
`.2@sha256:78bf2f1e8535928037abc35a9886614b3f722885b54f1f707a570e6991252710`;
`.1` remains only in immutable image metadata and historical records.

## Ownership and rollback

Dhawal Shah owns the registry package, workflow, dependency update, and incident
response. The required second human maintainer is currently unassigned, so
candidate trust remains blocked. If the maintenance commitment ends, follow the
deprecation and consumer-notice path in ``infra/REGISTRY_MAINTENANCE.md``. Never
fall back to a floating upstream tag or a vulnerability waiver.
