Trust and safety operating contract
===================================

Authority boundary
------------------

Mesh is a client, not a global moderator of federated communities. Community
admins control room membership and rules. Account-service operators control
their accounts and infrastructure. Mesh must identify the responsible operator
and give the user an actionable route without implying that an independent
service is owned or guaranteed by Mesh.

Product behavior
----------------

Message reporting must use interoperable Matrix reporting where available,
identify the destination, disclose when report text is sent in plaintext to an
operator, and fail visibly when no authorized route exists. Blocking, muting,
removal, bans, and power changes must reflect authoritative Matrix state rather
than optimistic local success. Security reports never belong in public issues.

Reports and appeals should collect the minimum necessary evidence. Do not copy
entire room histories, unrelated member data, access tokens, recovery keys, or
invitation capabilities into a report. Mesh cannot promise a universal appeal:
the UI and support site must route an appeal to the community admin or account
operator whose decision is being challenged.

Launch requirements
-------------------

Every promoted community-service offer needs published rules, a current abuse
contact, escalation coverage, retention terms, and a tested response path.
Before consumer beta, acceptance must exercise report submission, block and
mute behavior, permission loss during an action, banned-user re-entry,
federated abuse, provider deactivation, evidence minimization, and appeal
routing with accounts on different compatible services.

Do not invent custom federated deletion, global-ban, evidence-retention, or
appeal semantics in client code. Those require an owner-approved product rule
and protocol/security review before implementation.
