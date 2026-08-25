import assert from 'node:assert/strict'
import test from 'node:test'
import {
  collectCommandParameters,
  collectInvocationPayloads,
  findArgumentDrift,
} from './check-ipc-arguments.mjs'

const rustFixture = `
#[tauri::command]
pub async fn matrix_update_channel(
    community_id: String,
    channel_id: String,
    name: Option<String>,
    state: State<'_, AppState>,
) -> Result<ChannelDto, CommandError> {
    Ok(())
}

#[tauri::command]
pub async fn matrix_get_messages(
    room_id: String,
    request_id: String,
    deadline_ms: u64,
    notifications: State<'_, NotificationState>,
) -> Result<Vec<MessageDto>, CommandError> {
    Ok(())
}

async fn with_deadline<F, T>(future: F, operation: &str) -> Result<T, CommandError> {
    Ok(())
}
`

test('reads parameters without being derailed by a lifetime quote', () => {
  // State<'_, AppState> contains a single quote. Treating it as a string start
  // made the scanner run past the parameter list into the next function's.
  const commands = collectCommandParameters(rustFixture)
  assert.deepEqual(commands.get('matrix_update_channel'), ['community_id', 'channel_id', 'name'])
  assert.deepEqual(commands.get('matrix_get_messages'), ['room_id', 'request_id', 'deadline_ms'])
  assert.equal(commands.has('with_deadline'), false)
})

test('reads a parameter preceded by a doc comment with a comma in it', () => {
  // A comment directly above a parameter, with no comma separating them, is
  // part of that parameter's entry once split on top-level commas. Left
  // unstripped, the entry starts with `//` instead of an identifier, the
  // declaration regex never matches, and the parameter silently disappears.
  const commands = collectCommandParameters(`
#[tauri::command]
pub async fn matrix_send_message(
    room_id: String,
    // Whether this asks to notify the whole room: a caller who lost the
    // power level gets a refusal, not a message that quietly notified nobody.
    mentions_room: Option<bool>,
) -> Result<(), CommandError> {
    Ok(())
}
`)
  assert.deepEqual(commands.get('matrix_send_message'), ['room_id', 'mentions_room'])
})

test('drops managed state by type, not by parameter name', () => {
  // `notifications: State<...>` is injected, but a name-based list reads it as
  // an argument the renderer forgot to send.
  const commands = collectCommandParameters(rustFixture)
  assert.equal(commands.get('matrix_get_messages').includes('notifications'), false)
})

test('reads shorthand and explicit payload keys on one line', () => {
  const payloads = collectInvocationPayloads(`
    tauriInvoke('matrix_update_channel', { communityId, channelId, name: changes.name ?? null })
  `)
  assert.deepEqual([...payloads.get('matrix_update_channel')], ['communityId', 'channelId', 'name'])
})

test('is not split by a comma inside a string argument', () => {
  const payloads = collectInvocationPayloads(`tauriInvoke('cmd', { scope: 'a, b', other: 1 })`)
  assert.deepEqual([...payloads.get('cmd')], ['scope', 'other'])
})

test('accepts a payload that matches the compiled parameter list', () => {
  const bridge = `tauriInvoke('matrix_update_channel', { communityId, channelId, name })`
  assert.deepEqual(findArgumentDrift(bridge, rustFixture), [])
})

test('catches a renamed argument, which no build or mocked test would', () => {
  // The failure mode this gate exists for: Tauri deserializes by name, so a
  // renamed key type-checks, builds, and passes every mocked test, then fails
  // at runtime on a user's machine.
  const bridge = `tauriInvoke('matrix_update_channel', { communityId, roomId, name })`
  assert.deepEqual(findArgumentDrift(bridge, rustFixture), [{
    command: 'matrix_update_channel',
    unknown: ['roomId'],
    missing: ['channelId'],
  }])
})

test('lets the invoke wrapper supply requestId and deadlineMs', () => {
  const bridge = `tauriInvoke('matrix_get_messages', { roomId })`
  assert.deepEqual(findArgumentDrift(bridge, rustFixture), [])
})
