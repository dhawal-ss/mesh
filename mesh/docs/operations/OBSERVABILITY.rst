Privacy-safe observability
==========================

Current boundary
----------------

Mesh does not upload analytics, crash reports, message content, account IDs,
room IDs, invitation capabilities, access tokens, recovery material, process
arguments, or backtraces. A native panic writes one bounded
``crash-diagnostics/last-crash.json`` marker under the operating system's Mesh
application-data directory. It replaces the previous marker and never leaves
the device automatically.

The marker contains only its schema version, UTC time, Mesh version, operating
system, CPU architecture, source-file basename, and source line. It deliberately
omits the panic payload and full source path. Failure to write the marker must
never cause a second panic.

Release requirements
--------------------

The diagnostics panel now provides a bounded, allowlisted JSON support bundle
flow that:

* shows every field before export and requires an explicit user action;
* redacts credentials, invitation URLs, identifiers, content, filesystem paths,
  and environment variables by default;
* uses a 16 KiB maximum file and tells the user to delete it after support no
  longer needs it;
* never uploads automatically and never treats silence as consent; and
* keeps local diagnostics useful when all network telemetry is disabled.

Metrics and alerts for an optional community-hosted service belong to that
operator. They must cover availability, federation, certificate expiry, backup
age, restore evidence, disk pressure, database health, and abuse contact health
without collecting room content. Passing a disposable test stack is not live
operational evidence.

Stop conditions
---------------

Do not add a telemetry SDK, remote endpoint, stable installation identifier, or
automatic crash upload until the data dictionary, consent UX, retention,
deletion, access control, incident use, and public privacy text have completed
security and legal review.
