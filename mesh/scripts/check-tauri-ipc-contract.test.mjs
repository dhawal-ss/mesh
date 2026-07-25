import assert from 'node:assert/strict'
import test from 'node:test'
import {
  collectInvokedCommands,
  collectRegisteredCommands,
  findUnregisteredCommands,
} from './check-tauri-ipc-contract.mjs'

test('collects typed and untyped literal invocations', () => {
  const commands = collectInvokedCommands(`
    tauriInvoke('plain_command')
    tauriInvoke<Result<string>>("typed_command", { value: true })
    tauriInvoke(dynamicCommand)
  `)

  assert.deepEqual([...commands], ['plain_command', 'typed_command'])
})

test('collects handlers from every backend registration block', () => {
  const commands = collectRegisteredCommands(`
    tauri::generate_handler![
      commands::backend::matrix_login,
    ])
    tauri::generate_handler![
      commands::identity::create_identity,
    ])
  `)

  assert.deepEqual([...commands].sort(), ['create_identity', 'matrix_login'])
})

test('reports a frontend command that has no registered handler', () => {
  const bridge = `
    tauriInvoke('matrix_login')
    tauriInvoke('dead_command')
  `
  const rust = `
    tauri::generate_handler![
      commands::backend::matrix_login,
    ])
  `

  assert.deepEqual(findUnregisteredCommands(bridge, rust), ['dead_command'])
})
