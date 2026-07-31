# Mesh Agent 3 wave-two handoff

Date: 2026-07-30

Verdict: `LEAF_WORK_READY_FOR_INTEGRATION`

Reason: C0's Matrix reader, typed projection, aggregate logic, truthful UI, and
server-side role guards are implemented and pass focused local tests. The
shared `MeshBackend` trait, Tauri command registration, generated IPC contract,
bridge call, and sync-event subscription are intentionally not edited under the
parallel ownership contract. Until those hooks land, the product UI keeps role
application disabled rather than presenting a template as current state. C1-C5
were not started because C0 is the ordered hard gate and its shared runtime
integration remains open.

## Files changed and root causes fixed

- `mesh/src/lib/community-permissions.ts`
  - Adds an explicit per-room Matrix projection and aggregate results for
    granted everywhere, granted in some rooms, not granted, and unknown.
  - Keeps the proposed Mesh role template separate from current server state.
  - Computes current and proposed permissions from actual per-room thresholds.
  - Blocks self-assignment, unreadable-state changes, protected creator
    demotion, lower-authority role changes, and changes that would leave no
    recovery path after `m.room.power_levels` is hardened to level 100.
- `mesh/src/lib/community-permissions.test.ts`
  - Covers Matrix defaults, Mesh-created policy, divergent rooms, remote edits,
    restart serialization, inaccessible/failed/unsupported rooms, incomplete
    discovery, a federated room ID, escalation, and final-owner protection.
- `mesh/src/components/community/RolePermissionPreview.tsx`
  - Removes the implicit default-policy fallback.
  - Requires explicit template, current, proposed, loading, or unavailable
    evidence.
  - Labels templates as proposed and never as current state.
  - Exposes retry and diagnostic actions when authority cannot be verified.
- `mesh/src/components/community/RolePermissionPreview.test.tsx`
  - Covers template/current/proposed/loading/unavailable/partial/unknown UI.
- `mesh/src/components/community/MemberList.tsx`
  - Requires authoritative projection before enabling Apply.
  - Revalidates actor, target, and recovery state before invoking the bridge.
  - Requests a fresh projection when the role dialog opens and after the role
    operation completes.
- `mesh/src/components/community/MemberList.test.tsx`
  - Covers keyboard opening, authoritative proposed evidence, delayed mutation,
    bridge application, and both refresh requests.
- `mesh/src-tauri/src/backend/matrix/moderation.rs`
  - Continues to harden `m.room.power_levels` for Mesh-created rooms.
  - Reads current/defaulted room power levels before a role write.
  - Validates the actor, protected creators, and resulting recovery path on
    every reached room before sending the state event.
  - Supports a room with no explicit power-level event through Matrix defaults
    instead of failing or inventing Mesh defaults.
- `mesh/src-tauri/src/backend/matrix/moderation/permission_projection.rs`
  - Adds the bounded authoritative reader leaf API for a Space, nested Spaces,
    joined children, arbitrary/federated room IDs, missing/defaulted state, and
    inaccessible rooms.
  - Projects `users`, `users_default`, `events`, `events_default`,
    `state_default`, ban, kick, invite, redact, notification thresholds,
    creators, privileged creators, and joined users.
  - Uses plain failure reasons and never exposes raw remote errors.
  - Caps discovery at 2,048 rooms; exceeding the bound produces unknown rather
    than a silently partial answer.

The original root cause was that a local role label plus one fixed template was
being presented as effective authority. That was incorrect for existing,
federated, manually edited, defaulted, partially joined, or divergent rooms.
Role mutation also lacked a per-room, post-write recovery-path check.

## Permission evidence

- Current: derived from each room's current Matrix user level and thresholds.
- Proposed: substitutes only the proposed target user level while retaining
  every current room threshold.
- Partial: reports "Some rooms" when all rooms were read but thresholds differ.
- Unknown: any inaccessible, unsupported, failed, undiscovered, or unprojected
  authoritative room makes the community aggregate unknown.
- Matrix default: represented separately as `matrix-default`; it is not called
  a Mesh policy.
- Template: available only through explicit `{ kind: "template", policy }`
  evidence and visibly says it is not current server state.

## Guided onboarding and forum results

- C1 guided community entry: not started.
- C2 forum/events leaf work: not started.

These remain ordered behind C0 runtime integration. No invitation/account
chooser or Agent 1 onboarding files were edited.

## Matrix interoperability

- Reads and writes standard `m.room.power_levels`.
- Uses Matrix SDK default semantics when the event is absent.
- Discovers standard `m.space.child` relationships and nested Spaces.
- Does not assume a Mesh server name, room ID domain, or Mesh-created defaults.
- The role write remains a standard state event, so another compatible Matrix
  client can inspect the resulting authority.

No live second-client or two-homeserver acceptance was run in this tranche.
That remains required after the command and refresh hooks are integrated.

## Integration, expression, security, and privacy results

- C3 scoped integrations: not started and remain disabled.
- C4 polls, stickers, voice notes, GIF search, and link previews: not started.
- No renderer secret, remote provider, webhook, bot, plaintext integration, or
  direct renderer fetch path was added.
- The permission reader returns policy/membership metadata only; it does not
  return credentials or message plaintext.
- Raw Matrix/store errors are mapped to bounded, actionable room outcomes.
- Role mutations remain server-enforced and fail closed on unreadable authority
  or membership.

## Accessibility, scale, performance, and bundle evidence

- Loading uses `aria-busy` and a polite status.
- Unavailable and unknown states use alerts plus real buttons.
- The preview has an associated heading and text labels rather than
  color-only state.
- Existing full-size keyboard menu and confirmation behavior remains covered.
- The 5,000-member DOM-bounding test still passes.
- Reader traversal is cycle-safe and capped at 2,048 rooms.
- The aggregate has seven fixed permissions and bounded per-room work.
- No dependency or lockfile change was made.
- C5 SDK cache ADR, cold-sync benchmark, i18n extraction, and mobile decision:
  not started.
- Production build passed. Current budgets are:
  - entry: 201.18 / 350.00 KiB;
  - eager JavaScript: 513.50 / 525.00 KiB;
  - all JavaScript: 1962.16 / 2048.00 KiB;
  - CSS: 74.52 / 100.00 KiB;
  - fonts: 332.28 / 400.00 KiB;
  - all production assets: 2368.95 / 2500.00 KiB.

Eager JavaScript has only 11.50 KiB of headroom. This is an additional reason
not to begin C1-C5 surfaces before their intended lazy-loading boundaries are
reviewed.

## Capabilities that remain disabled or unavailable

- Role Apply when no authoritative projection is loaded.
- Automatic production refresh from remote `m.room.power_levels` and
  `m.space.child` sync events until the shared event hook is registered.
- C1 guided entry, C2 forums/non-media events, C3 integrations, C4 expression
  features, and C5 cache/i18n/mobile work.
- Live stages without Agent 2's `LIVE_RTC_ACCEPTED`.
- Marketplace, remote-code execution, bot hosting, direct GIF/link-preview
  renderer requests, and encrypted plaintext integrations.

## Exact shared-file and IPC integration requests

Agent 1 should apply these as one same-SHA integration:

1. Make the DTOs in
   `backend/matrix/moderation/permission_projection.rs` nameable by the backend
   trait. Preferred: move the DTO declarations to `backend/mod.rs` (or a public
   `types/community.rs` module) and import them back into the leaf. Preserve the
   serialized camelCase/kebab-case contract exactly.
2. Add to `MeshBackend`:

   ```rust
   async fn community_permission_projection(
       &self,
       community_id: String,
       subject_user_id: String,
   ) -> BackendResult<CommunityPermissionProjection>;
   ```

   The non-Matrix default must return
   `BackendError::Unsupported("community permission projection")`.
3. In `impl MeshBackend for MatrixBackend`, call the existing inherent leaf:

   ```rust
   MatrixBackend::community_permission_projection(
       self,
       &community_id,
       &subject_user_id,
   ).await
   ```

4. Add a read-only command in `commands/backend.rs`:

   ```rust
   matrix_get_community_permission_projection(
       community_id: String,
       subject_user_id: String,
       state: State<'_, AppState>,
   ) -> Result<CommunityPermissionProjection, CommandError>
   ```

   Gate it with `require_matrix`, use the normal read IPC timeout, and register
   it in both `tauri::generate_handler!` lists in `src-tauri/src/lib.rs`.
5. Add every new DTO/enum to `src-tauri/src/bin/export_ipc_types.rs`, run
   `npm run generate:ipc-types`, and accept only a deterministic
   `src/types/ipc.generated.ts` diff.
6. Add to `src/lib/bridge.ts`:

   ```ts
   getCommunityPermissionProjection(communityId, subjectUserId)
   ```

   invoking `matrix_get_community_permission_projection` with
   `READ_IPC_OPTIONS`.
7. Wire projection state to `MemberList`:
   - `rolePermissionProjection`
   - `rolePermissionsLoading`
   - `onRetryRolePermissions`
   - `onOpenPermissionDiagnostics`

   A generation token must prevent an older community/user request from
   overwriting a newer one. Keep the last projection out of persistence.
8. Refresh after:
   - role operation completion, including partial results;
   - room create/add/remove and nested-Space changes;
   - sync restart/session restore;
   - remote `m.room.power_levels` and `m.space.child` state events.

   Add a typed backend event such as `MatrixPermissionStateChanged { room_id }`
   to `MatrixBackendEvent`, emit it from Matrix SDK state handlers, forward it
   through the existing app event dispatcher, and expose one bridge listener.
   Debounce/coalesce by active community and discard stale generations.
9. Diagnostics should list each room's status and plain failure reason without
   protocol dumps, tokens, URLs containing credentials, or message content.
10. Re-run generation, IPC-contract, focused, full build, live federated, and
    compatible-client acceptance on the exact integrated SHA.

## Verification completed

Passed:

```text
npx vitest run src/lib/community-permissions.test.ts \
  src/components/community/RolePermissionPreview.test.tsx \
  src/components/community/MemberList.test.tsx --maxWorkers=1
  3 files, 16 tests passed

npx eslint <six changed TypeScript/TSX files>
  passed

npx tsc --noEmit
  passed

npm run lint
  passed

npm test -- --maxWorkers=1
  90 files, 644 tests passed

npm run build
  passed

npm run check:design-tokens
npm run check:icons
npm run check:bundle-size
  passed

npm run check:ipc-contract
  171 commands, passed

npm run check:ipc-types
  passed; checked-in generated contract remained unchanged

git diff --check
  passed

CARGO_BUILD_JOBS=1 cargo test --manifest-path src-tauri/Cargo.toml \
  --no-default-features --features matrix-backend --locked --jobs 1 \
  --lib moderation
  11 tests passed
```

Pending final shared barrier:

- IPC regeneration/contract check after the new DTO and command registration;
- live Matrix/federation/compatible-client acceptance.

## Unresolved service and external blockers

- Shared IPC and event registration authority.
- A live pair of compatible homeservers/accounts for federated and
  second-client acceptance.
- C1-C5 product and infrastructure prerequisites described in the revised plan.
- Agent 2 RTC evidence for any stage/media availability.
