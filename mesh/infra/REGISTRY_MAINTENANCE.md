# Mesh container registry maintenance

Mesh operates the public `ghcr.io/dhawal-ss/mesh-caddy` and
`ghcr.io/dhawal-ss/mesh-lk-jwt-service` packages. These images are release
dependencies, not unattended mirrors. Their exact digests remain usable only
while this maintenance contract and its automated controls pass.

## Machine-enforced contract

The checks in `scripts/check-registry-digest-age.mjs` and
`scripts/check-registry-tag-movement.mjs` read this block directly. Changing a
value here changes the gate; duplicating these values in a workflow is not an
approved override.

<!-- BEGIN MESH REGISTRY MAINTENANCE CONTROL
{
  "schemaVersion": 1,
  "registry": "ghcr.io/dhawal-ss",
  "primaryOwner": "Dhawal Shah",
  "backupOwner": null,
  "backupOwnerStatus": "UNRESOLVED_OWNER_ASSIGNMENT_REQUIRED",
  "rebuildCadenceDays": 28,
  "maximumDigestAgeDays": 35,
  "fixableHighOrCriticalResponseHours": 24,
  "upstreamSecurityPatchWindowHours": 168,
  "manualPublicationWorkflow": ".github/workflows/container-candidates.yml"
}
END MESH REGISTRY MAINTENANCE CONTROL -->

## Ownership

Dhawal Shah owns both packages, their source and dependency review, scheduled
rebuilds, incident response, and consumer notices. The repository contains no
second named maintainer, so the backup-owner requirement is explicitly
unresolved. Before either image can be trusted for a public release, a real
person with package and protected-workflow access must accept the backup role
and replace the unresolved field above. A role name or invented person is not
an acceptable substitute.

## Cadence and expiry

- Scan every pinned digest weekly, as required by
  `infra/container-candidates/candidate-policy.json`.
- Rebuild each maintained image at least every 28 days, even when its upstream
  source revision is unchanged. Use a new Mesh release tag for every rebuild.
- Treat a digest as expired after 35 days. The seven-day difference between
  the rebuild cadence and expiry allows one scheduled maintenance cycle to
  finish without turning the maximum into a target.
- Measure age from the oldest `created` timestamp in the immutable Linux
  AMD64 and ARM64 OCI configs bound by the policy digest. This is conservative:
  republishing or moving a tag cannot make old image bytes appear new.

An expired or unreadable digest blocks the affected security and release gate.
Network, authorization, manifest, platform, timestamp, or registry parsing
errors fail closed rather than being treated as fresh evidence.

## Upstream patch trigger

A supported upstream release or dependency update that fixes a High or
Critical finding present in a maintained image starts the response clock.
Begin the update or rebuild within 24 hours and publish a reviewed replacement
within 168 hours of the supported fix becoming available. Any other upstream
security release that affects bundled code also requires a reviewed rebuild
within 168 hours. If Mesh cannot meet the applicable window, block the image
from candidate use and start the deprecation path; do not add a floating tag or
vulnerability waiver.

Every replacement must repeat the existing source-tag and source-commit
binding, upstream tests, Linux AMD64 and ARM64 build, non-root runtime check,
CycloneDX SBOM, zero-fixable-High-or-Critical scan, signature, provenance, and
applicable disposable deployment acceptance.

## Digest rotation and publication

Release tags are immutable. The checked-in repository has no publication
input, package-write permission, registry login, build, tag-creation, signing,
or attestation authority. Every scheduled, push, pull-request, and manual run
of `.github/workflows/container-candidates.yml` is read-only verification.

Every future publication requires a separate protected-branch source change.
That review must fix the exact evidence-backed source tag and digest, previously
unused target tag, and expected digest in code; provide a strict authoritative
absence probe; separate read-only evidence verification from a minimal
package-write job; and update both guarded validators and their negative tests
in the same change. Arbitrary selectors remain forbidden. After the one
authorized use, the publication input and all login, write, create, build,
sign, and attest authority must be retired immediately in the next reviewed
source state. The rotation is incomplete until that retirement is reviewed and
the permanent read-only validators pass again.

### The next rotation must re-sign both images

Both currently published images were signed from a branch that no longer
exists. Reading the sigstore bundles attached to each published digest gives
the certificate subject for both:

```
https://github.com/dhawal-ss/mesh/.github/workflows/container-candidates.yml@refs/heads/beta/production-readiness-2026-08
```

Both certificates were issued on 2026-08-10. The accepted signer identity has
since been narrowed to `refs/heads/main` in the five `cosign verify` flags and
in both policy files, because that beta branch is gone and `main` is the only
branch on origin.

The consequence is that **the published digests no longer satisfy the accepted
identity**, and `cosign verify` fails for both until they are rebuilt and
re-signed from `main`. This is not a separate defect to chase: the same
rotation is already required to clear the fixable High findings, and
`container-candidates.yml` now triggers only on `main`, so a rebuild there
produces a certificate that matches. Do not widen the regexp back to make the
old signatures verify — that would re-accept a signer identity that cannot be
produced any more.

Order the work as one rotation: rebuild both images from `main`, confirm the
scan is clean, re-sign, publish, then update `publishedDigest` in
`infra/container-candidates/candidate-policy.json` in the same reviewed change.

For a rotation:

1. In a protected-branch source change, review and fix the exact source tag and
   digest, unused target tag, and expected digest in the temporary workflow and
   both validators. Confirm the source's source-commit, patches, builder,
   platforms, SBOM, zero-fixable-High-or-Critical scan, signature, and
   provenance evidence before any write token is available.
2. Run the fixed temporary manual workflow once. It must refuse every existing,
   ambiguous, unreadable, or unauthorized target and must never move a tag.
   If a run fails after its sole mutation, inspect the live target before any
   other action; do not retry a completed tag creation.
3. Independently verify the new `tag@digest`, signature, CycloneDX attestation,
   and registry provenance and retain the immutable workflow evidence.
4. In one reviewed change, rotate the matching entry in
   `infra/container-security-policy.json`, every applicable `security.yml`
   matrix, release-security matrices, and every deployment or acceptance
   reference found by searching the repository for the old tag. Respect the
   policy milestone: `lk-jwt-service` is R3 and does not belong in the R2
   matrix in `.github/workflows/security.yml`. Do not merge a partial rotation.
5. Run the container supply-chain, registry-governance, deployment, backup,
   restore, federation, and voice gates applicable to that image. Keep the old
   digest available until consumers have moved and rollback is no longer
   required.
6. Immediately remove the temporary publish input, jobs, credentials, and
   mutation commands. Restore the permanent validators that reject every
   checked-in mutation surface, and rerun the full gate set before completion.

## Candidate trust is not release trust

The candidate trust policy in `infra/container-security-policy.json` sets
`trustedForCandidate: true` and `trustedForRelease: false`. Candidate trust
means only that the Mesh publishing identity, exact digest, signature, scan,
and provenance contract passed. Release trust may change to true only after a
named backup owner exists, the digest is unexpired, protected exact-SHA
security and release workflows pass, all applicable deployment and external
acceptance evidence passes on that same SHA and digest, and the owner approves
the reviewed policy change. Candidate publication alone cannot make this
change.

## Deprecation

If Mesh stops maintaining an image, immediately mark the affected release and
service gate blocked, remove the image from new-install and release references,
and publish an operator notice naming the last maintained digest, the end date,
the affected paths, and migration or shutdown instructions. Keep historical
evidence and the old digest available for a bounded migration window when safe;
do not silently replace it with an upstream tag. After the notice window,
archive or remove the package according to the published instructions.

## D10 incident note: `lk-jwt-service` tag movement near miss

On 2026-08-10, a canceled publication rerun moved the human-readable
`mesh-lk-jwt-service` tag. Impact was contained because deployment, acceptance,
and policy references used the original reviewed `tag@sha256:` value, so pulls
continued to bind the reviewed digest. During this control's implementation,
the old tag resolved to
`sha256:26416afcc68d80d91fd2c46379437c757555cb67ce9b56f400eea6badaa05022`
instead of the reviewed
`sha256:78bf2f1e8535928037abc35a9886614b3f722885b54f1f707a570e6991252710`.
Moving the existing tag back was not an approved repair.

Manual run `31439670038` proved the unused `0.5.0-mesh.2` target was absent and
failed before package-write authority because a digest-only source reference
could not satisfy the exact policy and SBOM evidence binding. Its publish job
was skipped. After the source was corrected to the policy-pinned exact
`0.5.0-mesh.1@sha256:78bf2f1e8535928037abc35a9886614b3f722885b54f1f707a570e6991252710`
reference, run `31440088902` passed target
absence, source resolution, fresh SBOM, zero-fixable-High-or-Critical scan,
signature, CycloneDX, provenance, and evidence validation. It then created
`0.5.0-mesh.2` at the exact reviewed digest. The run reported failure only
after creation because an early-exit `awk` parser under `pipefail` closed the
`imagetools inspect` pipe. The tag was already correct, so retrying the run is
forbidden. The reviewed one-use repair was corrected to capture the full
inspection output before parsing it, then retired with the rest of the
publication path.

Active policy, R3 security and release matrices, MatrixRTC deployment,
preflight, and acceptance references now use
`0.5.0-mesh.2@sha256:78bf2f1e8535928037abc35a9886614b3f722885b54f1f707a570e6991252710`.
The moved `.1` tag is retained only in immutable image metadata and historical
evidence; it is not an active consumer or mutation target. The one-shot publish
input and both recovery jobs were removed after use. The checked-in workflow is
now read-only, and registry governance rejects any current mutation surface.
The tag-movement guard proves every current policy tag resolves to its reviewed
digest. A missing, moved, ambiguous, or unreadable tag fails closed. A future
temporary publication workflow must change the guarded validators in the same
protected review and be retired immediately after its single use.
