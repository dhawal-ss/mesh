External authorization runbook
==============================

:Status: Prepared only. No command in an ``Apply`` or ``Rollback`` block has
  been executed.
:Repository: ``dhawal-ss/mesh``
:Prepared: 2026-08-02

This runbook deliberately separates read-only capture from externally mutating
steps. Stop unless the named owner has approved the exact target, reviewer,
source SHA, and rollback owner. Never place a secret value in command history.

GitHub governance
-----------------

Read-only snapshot
~~~~~~~~~~~~~~~~~~

Run from an access-controlled directory and retain the output with the approval
record::

  $Repo = 'dhawal-ss/mesh'
  $Evidence = Join-Path $PWD (Get-Date -AsUTC -Format 'github-before-yyyyMMddTHHmmssZ')
  New-Item -ItemType Directory -Path $Evidence -ErrorAction Stop | Out-Null
  gh api "repos/$Repo/branches/main/protection" | Set-Content -LiteralPath "$Evidence/branch-protection.json"
  gh api "repos/$Repo/environments" | Set-Content -LiteralPath "$Evidence/environments.json"
  gh api "repos/$Repo/actions/permissions" | Set-Content -LiteralPath "$Evidence/actions-permissions.json"
  gh api --include "repos/$Repo/private-vulnerability-reporting" | Set-Content -LiteralPath "$Evidence/private-vulnerability-reporting.txt"

The 2026-08-02 read-only capture found admin enforcement and seven required
checks, but no required review, no conversation-resolution requirement, no
environments, Actions allowed without required SHA pinning, and private
vulnerability reporting disabled.

Owner inputs and stop conditions
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

The repository owner must name an independent GitHub user or organization team
that can review both protected environments and pull requests. ``dhawal-ss``
cannot satisfy independent approval alone. Stop if the reviewer ID is absent,
if the reviewer cannot access the repository, if the current settings were not
captured, or if a required check name has not appeared on the approved source.

Apply after explicit approval
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Replace only ``approved-independent-reviewer`` with the approved login. The
payload otherwise names the exact target state::

  $Repo = 'dhawal-ss/mesh'
  $ReviewerLogin = 'approved-independent-reviewer'
  $ReviewerId = gh api "users/$ReviewerLogin" --jq '.id'
  if (-not $ReviewerId) { throw 'Independent reviewer ID is required' }

  $Protection = @{
    required_status_checks = @{
      strict = $true
      contexts = @(
        'Matrix Rust (ubuntu-latest)'
        'Matrix Rust (windows-latest)'
        'Legacy LAN Rust'
        'Frontend Build & Browser E2E'
        'Protected CI evidence manifest'
        'CodeQL JavaScript and TypeScript SAST'
        'Dependency and license review'
        'feature-matrix'
        'dependency-and-secret-audit'
        'sbom'
        'Protected security evidence manifest'
      )
    }
    enforce_admins = $true
    required_pull_request_reviews = @{
      dismiss_stale_reviews = $true
      require_code_owner_reviews = $true
      require_last_push_approval = $true
      required_approving_review_count = 1
    }
    restrictions = $null
    required_linear_history = $true
    allow_force_pushes = $false
    allow_deletions = $false
    block_creations = $false
    required_conversation_resolution = $true
    lock_branch = $false
    allow_fork_syncing = $false
  } | ConvertTo-Json -Depth 8
  $Protection | gh api --method PUT "repos/$Repo/branches/main/protection" --input -

  '{"enabled":true,"allowed_actions":"all","sha_pinning_required":true}' |
    gh api --method PUT "repos/$Repo/actions/permissions" --input -
  gh api --method PUT "repos/$Repo/private-vulnerability-reporting"

  $Environment = @{
    wait_timer = 0
    prevent_self_review = $true
    reviewers = @(@{ type = 'User'; id = [int64]$ReviewerId })
    deployment_branch_policy = @{
      protected_branches = $true
      custom_branch_policies = $false
    }
  } | ConvertTo-Json -Depth 6
  $Environment | gh api --method PUT "repos/$Repo/environments/matrix-beta" --input -
  $Environment | gh api --method PUT "repos/$Repo/environments/github-pages" --input -

Do not add signing, OAuth, updater, admission, MatrixRTC, or provider secrets
until the environment queries confirm reviewer protection and restricted refs.
Do not run a confidential-report drill with real vulnerability detail; use an
owner-approved synthetic report only after private reporting is enabled.

Post-check
~~~~~~~~~~

Repeat the read-only snapshot into a new ``github-after-*`` directory. Open a
synthetic pull request and prove that the independent approval, CODEOWNER review,
conversation resolution, aggregate CI/security evidence, CodeQL, and dependency
review are all required. Prove admins cannot bypass the rules. Cancel the test
deployment and retain only privacy-reviewed evidence.

Rollback
~~~~~~~~

Rollback is a reviewed exception, not a way to merge a failing change. Restore
the exact saved branch-protection and Actions payloads with ``gh api --method
PUT --input``. Delete only environments created by this change::

  gh api --method DELETE "repos/dhawal-ss/mesh/environments/matrix-beta"
  gh api --method DELETE "repos/dhawal-ss/mesh/environments/github-pages"

If private reporting must be disabled, record the incident and approval before::

  gh api --method DELETE "repos/dhawal-ss/mesh/private-vulnerability-reporting"

Managed service reconciliation
------------------------------

Required authorization
~~~~~~~~~~~~~~~~~~~~~~

The infrastructure owner must provide the authenticated operator identity,
approved checkout path, current exact image/config rollback point, encrypted
off-site backup destination, signing-key verifier, maintenance window, and
incident contact. Those values are not inferable from this repository. Stop
before mutation if any is absent.

Pre-change capture on the authorized operator host
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

From the approved ``infra/homeserver`` checkout::

  umask 077
  git rev-parse HEAD
  git status --short
  docker compose config --images
  docker compose ps
  sh ./status.sh
  sh ./operational-health.sh
  backup_path="$(sh ./backup.sh)"
  sh ./verify-backup.sh "$backup_path"
  sh ./offsite-backup.sh
  MESH_RESTORE_POSTGRES_PASSWORD="$(security find-generic-password -s 'Mesh Restore Drill Password' -w)" sh ./restore-drill.sh "$backup_path"

Independently record image IDs/digests, a redacted Compose config hash, database
and media capacity, signing-key hash/custodian verification, DNS/TLS/discovery
answers, public routes, monitoring status, and open incidents. Do not continue
unless the current image/config can be restored from an immutable retained copy.

Approved apply sequence
~~~~~~~~~~~~~~~~~~~~~~~

Use only the owner-approved exact source SHA. Review ``git diff`` between the
captured SHA and target before applying. Then, in order::

  git fetch --filter=blob:none origin
  git verify-commit <approved-source-sha>
  git worktree add --detach ../mesh-approved <approved-source-sha>
  cd ../mesh-approved/mesh/infra/homeserver
  docker compose config --quiet
  sh ./setup.sh
  sh ./start.sh
  sh ./status.sh
  sh ./operational-health.sh

The approved target must retain 404 for disabled admission and invitation
services and keep public registration closed. Publish Caddy/site routes and
privacy/security/support pages only after the product owner chooses the canonical
site hostname without breaking ``/.well-known/matrix/*`` discovery. External
probes must confirm no admin API, credential, private address, or raw error is
exposed.

Acceptance and rollback
~~~~~~~~~~~~~~~~~~~~~~~

Before declaring the change successful, complete two independent destructive
restore/restart/federation exercises, signing-key recovery, monitoring and alert
delivery, rate-limit/abuse and incident drills, measured owner-approved RPO/RTO,
capacity checks, migration material, and immutable evidence. Any failure rolls
back the affected service to the captured exact image/config and invokes::

  sh ./status.sh
  sh ./operational-health.sh

The exact rollback deployment command depends on the captured operator-specific
image/config path and therefore must be attached to the approval before apply;
do not invent it or overwrite signing keys. Preserve failed-deployment evidence.

Exact-source candidate and acceptance
-------------------------------------

The release owner must first approve a non-placeholder version, canonical
installer, legal text, signing/timestamping, updater posture, and clean source
SHA. Protected environments and exact R0 manifests must already pass. Dispatch
only a draft prerelease::

  $Version = '<owner-approved-non-placeholder-version>'
  $Tag = "v$Version"
  gh workflow run release-beta.yml --repo dhawal-ss/mesh --ref main --field release_version=$Version --field release_tag=$Tag --field validation_only=false

Stop if the workflow's checked-out SHA differs from the approved SHA. Retain the
signed installer digest, both SBOMs, checksums, provenance, legal payload, and
protected evidence manifests. Complete all 54 R2 cases for the Windows candidate,
or all 62 R4 cases for cross-platform support, in a separately retained artifact
conforming to ``release/external-acceptance.schema.json``. A failed case keeps its
capability blocked. Do not edit the tracked example into a live claim.

Rollback leaves immutable evidence intact, removes public promotion, and never
reuses the version or tag for replacement bytes. Deleting a draft or tag requires
a separate explicit owner approval. The updater stays disabled until its separate
key-rotation, downgrade, bad-update, and rollback contract is approved.

MatrixRTC
---------

Keep the public Matrix text/community build voice-disabled. After a separate
Matrix-voice artifact is installed on real devices and all 23 evidence cases are
complete, the final read-only validator is::

  cd D:\Creations\Applications\mesh\mesh
  npm run matrixrtc:preflight -- -Production -RequireLiveAcceptance

Do not enable or delete a fail-closed voice boundary from static configuration,
browser WebRTC, disposable federation, or validator-only results.
