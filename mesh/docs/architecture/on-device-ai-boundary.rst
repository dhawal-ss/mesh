On-device AI boundary
=====================

Mesh has no production AI feature today. If one is added, this boundary applies
before design or implementation work starts.

Required behavior
-----------------

* Inference stays on the user's device. Production code cannot add a third-party
  inference endpoint or AI-provider SDK. The reviewed manifest at
  ``security/ai-boundary.json`` keeps both network allowlists empty.
* AI code cannot send messages, create invitations, remove or ban people, change
  roles, or perform moderation. Suggestions must remain drafts that a person
  reviews and submits through the normal product controls.
* Local captions or models must be behind an explicit feature gate and off by
  default. Their UI must disclose CPU, memory, battery, and storage use before
  enabling them.
* Mesh must never silently download a model. Model acquisition requires a
  separate user action that states the source, size, storage location, and
  removal path.
* AI modules must carry the four markers enforced by the CI check:
  ``@mesh-ai-local-only``, ``@mesh-ai-feature-gate:``,
  ``@mesh-ai-resource-disclosure``, and ``@mesh-ai-no-auto-download``.

Review boundary
---------------

The CI check scans production source and dependency manifests, not prose. It
validates the checked policy manifest, rejects known provider dependencies and
endpoints globally, then applies
network, feature-gate, download, resource-disclosure, and user-authority checks
only to narrowly identified AI modules. Positive and negative fixtures keep the
rule behavior reviewable.

The same manifest is embedded and validated by ``src-tauri/src/ai_boundary.rs``.
Native authority permits only a draft suggestion and denies network, sending,
invitation, membership, role, and moderation actions. Renderer markers and the
source scanner are defense in depth; they never grant authority.
