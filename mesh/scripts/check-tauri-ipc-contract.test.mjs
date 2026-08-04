import assert from 'node:assert/strict'
import test from 'node:test'
import {
  collectInvokedCommandSets,
  collectAllowedCommands,
  collectRegisteredCommandSets,
  findCapabilityDrift,
  findInvocationDrift,
  findPermissionDrift,
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
