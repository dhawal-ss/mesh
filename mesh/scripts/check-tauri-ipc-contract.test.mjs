import assert from 'node:assert/strict'
import test from 'node:test'
import {
  collectDefinedCommands,
  collectInvokedCommandSets,
  collectAllowedCommands,
  collectRegisteredCommandSets,
  findUnregisteredDefinitions,
  findCapabilityDrift,
  findInvocationDrift,
  findPermissionDrift,
  findStaleUninvokedAllowlist,
  findUninvokedCommands,
} from './check-tauri-ipc-contract.mjs'

const rustFixture = `
  #[cfg(not(feature = "legacy-p2p"))]
  let builder = builder.invoke_handler(tauri::generate_handler![
    commands::backend::matrix_login,
    commands::common::open_file,
  ]);
  #[cfg(feature = "legacy-p2p")]
  let builder = builder.invoke_handler(tauri::generate_handler![
    commands::backend::matrix_login,
    commands::common::open_file,
    commands::identity::create_identity,
  ]);
`

test('classifies common and explicitly legacy renderer calls', () => {
  const commands = collectInvokedCommandSets(`
    tauriInvoke('matrix_login')
    tauriInvoke<Result<string>>("open_file", { value: true })
    invoke('cancel_native_request')
    legacyTauriInvoke('create_identity')
    tauriInvoke(dynamicCommand)
  `)
  assert.deepEqual([...commands.matrix], ['matrix_login', 'open_file', 'cancel_native_request'])
  assert.deepEqual([...commands.legacy], ['matrix_login', 'open_file', 'cancel_native_request', 'create_identity'])
})

test('parses Matrix and legacy handler inventories independently', () => {
  const commands = collectRegisteredCommandSets(rustFixture)
  assert.deepEqual([...commands.matrix], ['matrix_login', 'open_file'])
  assert.deepEqual([...commands.legacy], ['matrix_login', 'open_file', 'create_identity'])
})

test('fails a Matrix renderer call backed only by legacy', () => {
  const bridge = `tauriInvoke('create_identity')`
  assert.deepEqual(findInvocationDrift(bridge, rustFixture), {
    matrix: ['create_identity'],
    legacy: [],
  })
})

test('fails a legacy renderer call backed only by Matrix', () => {
  const legacyMissing = rustFixture.replace('commands::backend::matrix_login,\n    commands::common::open_file,\n    commands::identity', 'commands::common::open_file,\n    commands::identity')
  const bridge = `tauriInvoke('matrix_login')`
  assert.deepEqual(findInvocationDrift(bridge, legacyMissing), {
    matrix: [],
    legacy: ['matrix_login'],
  })
})

test('collects the explicit application permission inventory', () => {
  const permission = `commands.allow = ["matrix_login", "open_file"]`
  assert.deepEqual([...collectAllowedCommands(permission)], ['matrix_login', 'open_file'])
})

test('reports missing and stale permissions for each build', () => {
  const matrixPermission = `commands.allow = ["matrix_login", "removed_command"]`
  const legacyPermission = `commands.allow = ["create_identity", "legacy_stale"]`
  assert.deepEqual(findPermissionDrift(rustFixture, {
    matrix: matrixPermission,
    legacy: legacyPermission,
  }), {
    matrix: { missing: ['open_file'], stale: ['removed_command'] },
    legacy: { missing: ['open_file'], stale: ['legacy_stale', 'removed_command'] },
  })
})

test('fails capability crossover and extra build capability selection', () => {
  assert.deepEqual(findCapabilityDrift({
    matrixCapability: JSON.stringify({ permissions: ['mesh-main', 'mesh-legacy'] }),
    legacyCapability: JSON.stringify({ permissions: ['mesh-legacy'] }),
    matrixConfig: JSON.stringify({ app: { security: { capabilities: ['default', 'legacy'] } } }),
    legacyConfig: JSON.stringify({ app: { security: { capabilities: ['legacy'] } } }),
  }), [
    'The Matrix capability must never grant mesh-legacy',
    'The legacy capability must grant both mesh-main and mesh-legacy',
    'The Matrix Tauri config does not select only the default capability',
  ])
})

test('sees a command behind a multi-line generic clause containing a semicolon', () => {
  // The shape that made matrix_create_community invisible to this gate: the
  // generic argument is an object type literal, so it contains a `;`, and the
  // command literal sits on the following line.
  const commands = collectInvokedCommandSets(`
    const created = await tauriInvoke<{ community: Community; channel: Channel }>(
      'matrix_create_community',
      { name, description },
    )
  `)
  assert.deepEqual([...commands.matrix], ['matrix_create_community'])
})

test('sees a command behind a nested generic clause', () => {
  const commands = collectInvokedCommandSets(`tauriInvoke<Map<string, Channel[]>>('matrix_list_channels')`)
  assert.deepEqual([...commands.matrix], ['matrix_list_channels'])
})

test('sees a command forwarded through a declared helper', () => {
  // Both search commands reach the native side through invokeNativeSearch,
  // which takes a scope first and the command literal second.
  const commands = collectInvokedCommandSets(`
    return invokeNativeSearch(
      \`messages:\${communityId}\`,
      'matrix_search_messages',
      { query, communityId, limit },
    )
  `)
  assert.deepEqual([...commands.matrix], ['matrix_search_messages'])
})

test('ignores a non-literal command argument', () => {
  const commands = collectInvokedCommandSets(`
    tauriInvoke(dynamicCommand)
    invokeNativeSearch(scope, dynamicCommand, payload)
  `)
  assert.deepEqual([...commands.matrix], [])
})

test('does not let a string argument split the argument list', () => {
  const commands = collectInvokedCommandSets(`invokeNativeSearch('a, b', 'matrix_search_messages', {})`)
  assert.deepEqual([...commands.matrix], ['matrix_search_messages'])
})

test('reports a registered handler that no renderer call site reaches', () => {
  const bridge = `tauriInvoke('matrix_login')`
  assert.deepEqual(findUninvokedCommands(bridge, rustFixture, {}), {
    matrix: ['open_file'],
    legacy: ['create_identity', 'open_file'],
  })
})

test('honours the uninvoked allowlist and rejects a stale entry', () => {
  const bridge = `tauriInvoke('matrix_login')`
  assert.deepEqual(
    findUninvokedCommands(bridge, rustFixture, { open_file: 'reason', create_identity: 'reason' }),
    { matrix: [], legacy: [] },
  )
  assert.deepEqual(findStaleUninvokedAllowlist(rustFixture, { withdrawn_command: 'reason' }), [
    'withdrawn_command',
  ])
})

test('reads command definitions past stacked attributes and visibility', () => {
  const defined = collectDefinedCommands([
    {
      path: 'src-tauri/src/commands/backend.rs',
      source: `
        #[tauri::command]
        pub async fn matrix_login() {}

        #[tauri::command(rename_all = "snake_case")]
        #[allow(clippy::too_many_arguments)]
        pub(crate) fn open_file() {}

        pub fn not_a_command() {}
      `,
    },
  ])
  assert.deepEqual([...defined.keys()], ['matrix_login', 'open_file'])
})

test('reports a command that neither handler inventory names', () => {
  const defined = collectDefinedCommands([
    {
      path: 'src-tauri/src/commands/migration.rs',
      source: '#[tauri::command]\npub async fn export_legacy_archive() {}',
    },
    {
      path: 'src-tauri/src/commands/backend.rs',
      source: '#[tauri::command]\npub async fn matrix_login() {}',
    },
  ])
  assert.deepEqual(findUnregisteredDefinitions(defined, rustFixture), [
    'export_legacy_archive (src-tauri/src/commands/migration.rs)',
  ])
})

test('accepts a command registered only by the legacy inventory', () => {
  const defined = collectDefinedCommands([
    {
      path: 'src-tauri/src/commands/identity.rs',
      source: '#[tauri::command]\npub async fn create_identity() {}',
    },
  ])
  assert.deepEqual(findUnregisteredDefinitions(defined, rustFixture), [])
})
