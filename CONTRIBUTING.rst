Contributing to Mesh
====================

Mesh welcomes focused contributions that preserve the consumer-app experience,
Matrix interoperability, privacy boundaries, and fail-closed release gates.

License and certificate of origin
---------------------------------

Mesh uses ``AGPL-3.0-only``. Contributions are accepted under the same license;
there is no contributor license agreement for the first public beta.

Every commit must include a Developer Certificate of Origin 1.1 sign-off. By
adding the line below, the contributor certifies that they have the right to
submit the work under the repository license::

  Signed-off-by: Full Name <email@example.com>

Git can add the sign-off to a new commit with ``git commit -s``. Reviewers must
not merge an unsigned contribution or silently add a sign-off for somebody else.

Product boundaries
------------------

Before changing onboarding, identity, community authority, decrypted storage,
moderation, native security, installer behavior, release publication, hosting,
mobile support, or extensions, read
``mesh/release/owner-decisions.json`` and ``AGENTS.md``. A change that conflicts
with either contract needs a new explicit owner decision before implementation.

Account hosting and community hosting must remain separate. Public Matrix
services must be described as independently operated, custom compatible
services must remain supported, and ordinary users must not be asked to make
infrastructure decisions that Mesh can safely make.

Verification
------------

Run the narrow tests for the code you changed and the relevant contract checks.
At minimum, product-boundary changes must pass::

  cd mesh
  npm run check:owner-decisions
  npm run check:beta-contract

Release, signing, deployment, and public claims require the separate protected
workflows and exact-source evidence described in the release documentation.
