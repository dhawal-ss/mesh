Advanced permission extension: schema and threat model
======================================================

Status
------

Design-only and blocked for product/protocol review. The evaluator in
``src/lib/advanced-permissions.ts`` is an audit and preview primitive. It is
not an enforcement boundary and must not be connected to permission UI as if
it changed Matrix authorization.

Proposed schema
---------------

Version 1 binds one document to a community control room, the exact
authoritative Matrix power-level event revision, and four fixed layers:
``server-group``, ``client-override``, ``channel-group``, then
``channel-override``. A rule identifies a permission, subject, author,
claimed author power, required power, and one effect:

* ``allow`` replaces the prior decision with allow;
* ``deny`` replaces it with deny;
* ``skip`` leaves the prior decision unchanged;
* ``negate`` reverses a prior explicit decision and otherwise leaves the
  fail-closed default at deny.

Within a layer, rule IDs sort lexically. Later rules and then more-specific
layers win. Every claimed power and required-power value must exactly match a
fresh authoritative Matrix projection. Unknown versions, fields, values,
stale revisions, replaced rooms, inaccessible state, or insufficient author
power produce ``unsupported`` and therefore a closed Advanced UI.

Threats and required controls
-----------------------------

Untrusted members may forge role names, powers, required powers, revisions,
layer order, duplicate IDs, effects, or room IDs. Remote servers may withhold
state, race a power-level update, replay state from a predecessor room, or
disagree about a custom event. A malicious rule may remove the final owner or
create a renderer-only allow that a standard Matrix server correctly denies.
The parser therefore bounds collections and strings, rejects non-finite or
out-of-range powers, verifies all authority against current Matrix state,
binds state to the current room and revision, and protects the owner recovery
path.

Exact blocker
-------------

Mesh does not yet have a reviewed Matrix state-event type, authorization
rules, federation conflict resolution, room-upgrade migration rule, or
server-side enforcement mechanism for this extension. Standard Matrix clients
would ignore it. Shipping an Advanced renderer now would create a permission
illusion, so implementation stops at this schema, threat model, evaluator,
and tests pending an interoperability and product decision.
