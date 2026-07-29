# Mesh Product North Star

Mesh must feel like a regular consumer communication app, even though it is
built on decentralized infrastructure. A normal user should be able to:

1. install Mesh;
2. open an invitation;
3. create or sign in to an account; and
4. enter the community.

That path must not require the user to understand or configure Matrix,
homeservers, federation, DNS, TLS, ports, relays, TURN, Synapse, or storage
replication.

## Non-negotiable UX rules

- Ship a simple, explicit account-service choice in release builds: Matrix.org
  as a prominent public option, a community-hosted service when an invitation
  offers one, additional reviewed public options, and "use another service".
- Do not silently select an account service or imply that an independently
  operated public service is owned, endorsed, or guaranteed by Mesh.
- Invitation links must carry or resolve everything needed to reach the
  community, but must not force the invitee's account to live on the
  community's homeserver. Account hosting and community hosting are separate.
- Use plain product language such as "service", "community", and "voice";
  reserve protocol terminology for diagnostics and advanced settings.
- Keep "use another service" and custom homeserver support as a first-class
  path so decentralization does not become lock-in.
- Detect service capabilities and network conditions automatically. Do not ask
  users to make infrastructure decisions that Mesh can make safely.
- Errors must explain what the user can do next without exposing raw protocol
  failures as the primary message.
- Never silently consume a user's disk, bandwidth, or battery for shared
  storage. Contribution must be explicit, bounded, encrypted, observable, and
  reversible.
- Treat extra setup steps in the default onboarding path as product defects
  unless they are required for account security or informed consent.

## Architecture guardrails

- Mesh must not require a paid Mesh-operated homeserver. Matrix.org is a
  prominent independently operated public option; the Mac mini is an optional
  community-hosted/bring-your-own service with no uptime SLA; and arbitrary
  compatible homeservers remain supported.
- Keep the selected account service, community room-routing servers, and any
  optional community admission/registration service separate in configuration
  and code.
- A user whose account is hosted on one compatible service must be able to join
  a community hosted on another through federation when room policy permits.
- Keep identity, membership, permissions, text history, encryption state, and
  synchronization on the Matrix-compatible control plane.
- Treat peer-assisted storage as an optional encrypted data plane with durable
  anchors, replication targets, integrity verification, repair, quotas, and
  garbage collection.
- Preserve standard Matrix interoperability wherever possible so users and
  communities can bring another compatible homeserver.
- Infrastructure choices must be migration-ready: stable identity domains,
  backed-up signing keys, portable databases/media, and configuration separate
  from secrets.

## Product references

Cinny is a useful reference for its calm interface, familiar
community/channel organization, and configuration-driven homeserver defaults.
Mesh should learn from that simplicity while hiding more infrastructure from
the recommended user path. Do not copy Cinny branding or code without an
explicit compatibility and licensing review.
