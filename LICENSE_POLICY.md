# Dependency license policy

Mesh source is licensed under `AGPL-3.0-only`. New dependencies must have a
machine-readable SPDX license accepted by `.github/dependency-review-config.yml`
and must pass the pinned dependency-review job before merge.

Permissive, public-domain, font, documentation, and weak-copyleft licenses in the
reviewed allowlist are acceptable when their notice, attribution, source, and
redistribution duties are preserved. A new strong-copyleft, source-available,
non-commercial, field-of-use, custom, missing, or ambiguous dependency license is
blocked pending an explicit owner and legal review; it must not be added to the
allowlist merely to make CI green.

GitHub dependency review is a merge gate, not legal advice. Before a public beta,
the owner must review generated SBOMs and notices, confirm AGPL network-source
obligations, and decide whether contribution terms or a dual-license strategy are
needed. That owner/legal decision is external to local CI and remains fail-closed.
