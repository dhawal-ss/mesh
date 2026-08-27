# Mesh

Mesh is a consumer-first desktop communication app built with Matrix, Tauri,
Rust, React, and TypeScript. It keeps account hosting separate from community
hosting, supports compatible services chosen by the user, and keeps protocol
and infrastructure detail out of the normal invitation and onboarding path.

Mesh is under active development and has not published a production beta.
Unsigned developer builds are not consumer releases.

## Repository layout

- `mesh/` contains the desktop app, tests, release tooling, and optional
  community-service infrastructure.
- `site/` contains the static public website and invitation routes.
- `.github/` contains CI, security, preview, and release workflows.
- `CONTRIBUTING.rst` and `SECURITY.md` define contribution and vulnerability
  reporting policy.

Current architecture, operations, and security contracts live under
`mesh/docs/`. The implemented visual system is defined in
`mesh/DESIGN_LANGUAGE.md`. Generated audit captures, review reports, prompts,
agent handoffs, and local release evidence are intentionally not versioned.

## Local development

From PowerShell:

```powershell
cd mesh
npm ci
npm run dev
```

Useful checks:

```powershell
npm test
npm run lint
npm run build
npm run check:operations-contract
```

Rust verification is serialized to avoid competing Cargo jobs:

```powershell
npm run test:rust:matrix
```

See `CONTRIBUTING.rst` before changing product boundaries or preparing a
release. Release, signing, deployment, and public claims require separate
protected workflows and reviewed evidence.
