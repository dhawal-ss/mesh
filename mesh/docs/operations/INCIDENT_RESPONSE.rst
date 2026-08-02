Incident response contract
==========================

Scope and ownership
-------------------

Before a consumer beta, the release owner must name an incident commander,
security lead, client release lead, community-service operator, and public
communications owner. A single person may fill several roles, but every role
must have a primary and backup contact outside this repository.

Route incidents to the authority that can act:

* Mesh client vulnerabilities use GitHub private vulnerability reporting.
* Account access, provider moderation, or provider availability go to the
  selected account-service operator.
* Community membership, rules, and room moderation go to community admins.
* Optional community-hosted infrastructure goes to that service's operator.

Severity and first actions
--------------------------

``SEV-0`` means credible active compromise, signing-key exposure, destructive
federation identity loss, or widespread confidentiality loss. ``SEV-1`` means
major authentication, encryption, invitation, moderation, or availability
failure without confirmed widespread compromise. ``SEV-2`` is a bounded
degradation with a safe workaround. ``SEV-3`` is a normal defect.

For SEV-0 and SEV-1, preserve evidence, stop releases, close optional account
registration when abuse or capacity is involved, and establish a private
incident record. Never publish credentials or raw user content. Do not rotate a
Matrix server name or signing identity, roll a federated database backward, or
delete encrypted state as an improvised recovery step.

Recovery and communication
--------------------------

The incident commander records impact, affected versions and services, start
time, containment, owner, next update time, and explicit exit criteria. Client
rollback means shipping a reviewed signed replacement; automatic updates remain
disabled until their separate signed-update and rollback acceptance passes.

Community-service recovery follows the checked backup, verification, and
new-host restore procedures in ``infra/homeserver``. A restore is not complete
until identity keys, database, media, federation, login, encrypted messaging,
and monitoring are verified from outside the host network.

After closure, produce a sanitized review with the root cause, detection gap,
timeline, user impact, corrective owner, due date, and regression evidence.
Run at least one tabletop exercise and one independent restore exercise before
consumer-beta promotion; local prose alone is not acceptance evidence.
