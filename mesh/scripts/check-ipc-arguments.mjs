import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/*
  The renderer-to-native seam.

  Every other gate in this repo tests one side of this boundary in isolation.
  Playwright and Vitest mock the bridge, the Rust live tests call the backend
  API directly, and check-tauri-ipc-contract.mjs proves only that a command
  *name* exists on both sides. Nothing checked that the argument object the
  renderer sends is the argument list the command actually takes.

  That gap is not theoretical. Tauri deserializes the payload into the command's
  parameters by name, so a renamed or misspelled key does not fail at build
  time, at type-check time, or in any mocked test: it fails at runtime, on a
  user's machine, as a deserialization error the renderer reports as a generic
  failure.

  What this checks: for each command invoked from bridge.ts with an object
  literal payload, the keys are exactly the parameters the Rust command declares
  (camelCase against snake_case), ignoring parameters Tauri injects itself.

  What this does NOT check, and what still needs a driver run against a real
  homeserver: types, values, and semantics. A renderer can send a
  correctly-named argument carrying a value the backend rejects, which is
  precisely the shape of the approval-required defect. This gate is the
  mechanical half of the seam, not the whole of it.
*/

/**
 * Tauri supplies these from its own runtime, so a caller never sends them.
 *
 * Matched on the parameter's TYPE, not its name: several commands take more
 * than one piece of managed state and name them for what they hold
 * (`notifications`, `grants`), which a name-based list silently mistakes for
 * arguments the renderer forgot to send.
 */
const INJECTED_PARAMETER_TYPES = /^\s*(?:State\s*<|AppHandle\b|Window\b|WebviewWindow\b|Channel\s*<|tauri::)/

/**
 * Sent by the shared invoke wrapper rather than named at the call site, so they
 * are permitted on the Rust side without appearing in a payload literal.
 */
const WRAPPER_SUPPLIED_PARAMETERS = new Set(['request_id', 'deadline_ms'])

const snakeToCamel = (value) => value.replace(/_([a-z0-9])/g, (_, char) => char.toUpperCase())

const OPENERS = { '(': ')', '[': ']', '{': '}' }
/*
  Rust lifetimes are written with a single quote, as in State<'_, AppState>.
  Treating that as a string delimiter made the scanner swallow everything to the
  next quote, so a parameter list ran on into the following function's. Each
  language therefore declares its own delimiters.
*/
const QUOTES = {
  typescript: new Set(["'", '"', '`']),
  rust: new Set(['"']),
}
const CLOSERS = new Set([')', ']', '}'])

/**
 * Splits a parameter list or object body at commas that are not nested inside
 * brackets, generics, or string literals.
 */
function splitTopLevel(source, quotes = QUOTES.typescript) {
  const parts = []
  let depth = 0
  let current = ''
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (quotes.has(character)) {
      const end = source.indexOf(character, index + 1)
      const quoted = end === -1 ? source.slice(index) : source.slice(index, end + 1)
      current += quoted
      index += quoted.length - 1
      continue
    }
    if (character === '<' || OPENERS[character]) depth += 1
    else if (character === '>' || CLOSERS.has(character)) depth -= 1
    if (character === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += character
  }
  parts.push(current)
  return parts
}

/** Returns the text between `openIndex` and its matching close, or null. */
function balancedSlice(source, openIndex, quotes = QUOTES.typescript) {
  const stack = [OPENERS[source[openIndex]]]
  for (let index = openIndex + 1; index < source.length; index += 1) {
    const character = source[index]
    if (character === '\\') {
      index += 1
      continue
    }
    if (quotes.has(character)) {
      const end = source.indexOf(character, index + 1)
      if (end === -1) return null
      index = end
      continue
    }
    if (OPENERS[character]) {
      stack.push(OPENERS[character])
      continue
    }
    if (CLOSERS.has(character)) {
      if (stack[stack.length - 1] !== character) return null
      stack.pop()
      if (stack.length === 0) return source.slice(openIndex + 1, index)
    }
  }
  return null
}

/**
 * Strips Rust `//` line comments outside of string literals.
 *
 * A parameter list entry is whatever sits between two top-level commas, so a
 * doc comment directly above a parameter (with no comma separating them) is
 * part of the same entry as that parameter. Left in, the entry starts with
 * `//` instead of an identifier, the declaration regex never matches, and the
 * parameter silently disappears from the declared set.
 */
function stripRustLineComments(source) {
  let result = ''
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === '"') {
      const end = source.indexOf('"', index + 1)
      const quoted = end === -1 ? source.slice(index) : source.slice(index, end + 1)
      result += quoted
      index += quoted.length - 1
      continue
    }
    if (character === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index)
      index = end === -1 ? source.length - 1 : end - 1
      continue
    }
    result += character
  }
  return result
}

/** Parameter names declared by each `#[tauri::command]` function. */
export function collectCommandParameters(rustSource) {
  const commands = new Map()
  const declaration = /#\[tauri::command[^\]]*\]\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g
  for (const match of rustSource.matchAll(declaration)) {
    const openIndex = match.index + match[0].length - 1
    const parameters = balancedSlice(rustSource, openIndex, QUOTES.rust)
    if (parameters === null) continue
    const declared = splitTopLevel(stripRustLineComments(parameters), QUOTES.rust)
      .map((entry) => {
        const parsed = /^\s*(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:([\s\S]*)$/.exec(entry)
        if (!parsed) return null
        if (INJECTED_PARAMETER_TYPES.test(parsed[2])) return null
        // A deliberately unused parameter keeps its underscore in the wire
        // name, so strip only the marker prefix, not the separator underscores.
        return parsed[1].replace(/^_(?=[a-z])/, '')
      })
      .filter((name) => name)
    commands.set(match[1], declared)
  }
  return commands
}

/** Payload keys sent for each command invoked with an object literal. */
export function collectInvocationPayloads(bridgeSource) {
  const payloads = new Map()
  const invocation = /\b(?:tauriInvoke|legacyTauriInvoke|invoke)\s*(?:<[^()]*?>\s*)?\(/g
  for (const match of bridgeSource.matchAll(invocation)) {
    const openIndex = match.index + match[0].length - 1
    const args = balancedSlice(bridgeSource, openIndex)
    if (args === null) continue
    const command = /^\s*(['"])([^'"]+)\1\s*,/.exec(args)?.[2]
    if (!command) continue
    const braceIndex = args.indexOf('{')
    if (braceIndex === -1) continue
    const body = balancedSlice(args, braceIndex)
    if (body === null) continue
    const keys = new Set()
    for (const entry of splitTopLevel(body)) {
      // Handles `key: value`, shorthand `key`, and skips `...spread`.
      const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::|$)/.exec(entry)?.[1]
      if (key) keys.add(key)
    }
    if (keys.size > 0) payloads.set(command, keys)
  }
  return payloads
}

export function findArgumentDrift(bridgeSource, rustSource) {
  const declared = collectCommandParameters(rustSource)
  const sent = collectInvocationPayloads(bridgeSource)
  const problems = []
  for (const [command, keys] of sent) {
    const parameters = declared.get(command)
    if (!parameters) continue
    const expected = new Set(parameters.map(snakeToCamel))
    const optional = new Set([...WRAPPER_SUPPLIED_PARAMETERS].map(snakeToCamel))
    const unknown = [...keys].filter((key) => !expected.has(key)).sort()
    const missing = parameters
      .map(snakeToCamel)
      .filter((name) => !keys.has(name) && !optional.has(name))
      .sort()
    if (unknown.length > 0 || missing.length > 0) {
      problems.push({ command, unknown, missing })
    }
  }
  return problems
}

async function main() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const [bridgeSource, commandsSource] = await Promise.all([
    readFile(path.join(projectRoot, 'src', 'lib', 'bridge.ts'), 'utf8'),
    readFile(path.join(projectRoot, 'src-tauri', 'src', 'commands', 'backend.rs'), 'utf8'),
  ])
  const problems = findArgumentDrift(bridgeSource, commandsSource)
  if (problems.length > 0) {
    console.error('Renderer and native disagree about command arguments:')
    for (const { command, unknown, missing } of problems) {
      console.error(`- ${command}`)
      if (unknown.length > 0) console.error(`    renderer sends, native does not declare: ${unknown.join(', ')}`)
      if (missing.length > 0) console.error(`    native declares, renderer does not send: ${missing.join(', ')}`)
    }
    process.exitCode = 1
    return
  }
  const checked = collectInvocationPayloads(bridgeSource).size
  console.log(
    `IPC argument check passed (${checked} commands invoked with an object payload; `
    + 'names match the compiled parameter lists).',
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
