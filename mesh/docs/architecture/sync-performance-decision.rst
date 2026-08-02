Sync and performance decision record
====================================

Status
------

Mesh currently uses Matrix ``/sync`` through the SDK and virtualizes large room,
member, direct-message, and message surfaces. This remains the production path
until a clean benchmark proves that another interoperable SDK path improves
real accounts without weakening encryption, freshness, federation, recovery,
or custom-homeserver support.

Benchmark before migration
--------------------------

Use synthetic accounts at 50, 500, and 5,000 rooms plus a consented sanitized
large account. Measure cold sign-in to usable shell, warm start, initial sync,
incremental event latency, resident memory, CPU, network bytes, database growth,
scroll responsiveness, reconnect catch-up, and battery/wakeup pressure. Record
the exact Mesh SHA, SDK version, homeserver version, account shape, device,
network, and five-run variance.

Compare the current path with the SDK's supported sliding-sync successor only
when it works against Matrix.org, the optional community service, and a reviewed
custom compatible service. Encrypted messages, undecryptable placeholders,
room state, unread counts, edits, redactions, threads, invitations, device
verification, and recovery must remain correct through restart and federation.

Acceptance and rollback
-----------------------

A migration needs an owner-approved performance target and may not rely on a
single best-case account. It must improve at least cold/warm usability, memory,
or network cost without a statistically meaningful regression in event latency
or correctness. The old path stays available behind a short-lived rollback gate
through the acceptance campaign, then is deleted only after exact-SHA clean
device, soak, and federation evidence passes.

Stop if the candidate requires a Mesh-only homeserver extension, breaks custom
compatible services, changes encrypted-history semantics, loses events or
unread state, or depends on an unstable SDK API without an approved maintenance
owner. Do not expose the sync strategy as an onboarding decision.
