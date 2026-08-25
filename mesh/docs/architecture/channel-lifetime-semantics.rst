Channel lifetime semantics
==========================

Status
------

Domain model complete; Matrix state, scheduler, and moderation wiring are not
implemented. The model lives in ``src/lib/channel-lifecycle.ts``.

Lifecycle
---------

A temporary child is created under one designated parent after an
authoritative power check, rate-limit check, and audit identifier. Occupancy
comes from authoritative joined/call state. Reaching zero starts a persisted
grace deadline. Re-entry cancels the deadline. Expiry archives the room and
may publish an interoperable tombstone/replacement; it never promises global
deletion. A configured Matrix retention event can reduce retained history on
cooperating servers but does not revoke copies already federated elsewhere.

Archived rooms remain valid Matrix rooms for compatible clients. Rejoin is
normally denied by archived room policy, while an authorized owner can recover
the room if policy permits. Moderation and audit events survive archive.
Room upgrades carry lifecycle policy to the successor while the predecessor
retains its tombstone and audit trail.

Federation and recovery
-----------------------

Creation cannot grant a power level above the actor or the parent policy.
Remote and standard clients may ignore Mesh lifecycle metadata, but still see
ordinary Matrix membership, retention, join-rule, and tombstone state. Mesh
must describe an archive honestly and must not claim that remote history was
deleted.

Blocked product decision
------------------------

``restart-scoped`` is rejected. A zero-cost federated community has no single
server process or shared restart epoch: the account service, community host,
remote homeservers, and clients restart independently. Product must choose a
different explicit clock or event boundary before that lifetime can exist.
