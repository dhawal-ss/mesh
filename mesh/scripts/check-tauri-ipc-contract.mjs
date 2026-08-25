import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const BUILDS = ['matrix', 'legacy']

/**
 * Commands that are compiled and permitted but reach no renderer call site.
 * Every entry needs a reason, because an unreachable command is still attack
 * surface: it ships in the handler inventory and in the renderer's permission
 * allow-list. The registered-but-never-invoked check below fails on anything
 * not listed here, so this list cannot grow silently.
 */
const UNINVOKED_COMMANDS = Object.freeze({
  get_community_files:
    'legacy-p2p only; the LAN file surface was withdrawn before the Matrix beta and the handler has no renderer caller',
  subscribe_channel:
    'legacy-p2p only; Matrix subscription is driven by the sync loop, not an explicit renderer command',
  unsubscribe_channel:
    'legacy-p2p only; paired with subscribe_channel and equally unreached',
  // Each of these had a bridge.ts wrapper that nothing called. A wrapper with
  // no caller does not make a command reachable; it disguises dead capability
  // as a live call path, and it costs a reader the same time either way. The
  // wrappers are gone and the fact lives here, where it is legible.
  generate_identity:
    'legacy-p2p only; the LAN identity surface was withdrawn before the Matrix beta and no renderer creates one',
  export_identity:
    'legacy-p2p only; paired with generate_identity, and Matrix export runs through matrix_export_personal_data',
  import_identity:
    'legacy-p2p only; paired with generate_identity and equally unreached',
  get_channel_event_log:
    'legacy-p2p only; the LAN event-log surface has no renderer, and Matrix history comes from the sync loop',
  sync_local_channel:
    'legacy-p2p only; Matrix channels are room state and are never synced from the renderer',
  get_ice_server_status:
    'legacy-p2p only; MatrixRTC configures ICE through LiveKit, and the LAN ICE settings surface has no renderer',
  validate_ice_servers:
    'legacy-p2p only; paired with get_ice_server_status. Operator TURN validation runs through probe_api, not IPC',
  set_ice_servers:
    'legacy-p2p only; paired with get_ice_server_status and equally unreached',
})

/**
 * Command literals can reach `tauriInvoke` indirectly through a small number of
 * forwarding helpers, which a call-site regex cannot see. Each entry names the
 * helper and the zero-based position of its command argument.
 *
 * This list cannot go stale silently: a new forwarder makes its commands
 * invisible to `collectLiteralInvocations`, and the registered-but-never-invoked
 * check then fails until the forwarder is declared here.
 */
const COMMAND_FORWARDERS = Object.freeze([
  { name: 'invokeNativeSearch', argumentIndex: 1 },
])

const OPENERS = { '(': ')', '[': ']', '{': '}' }
const CLOSERS = new Set([')', ']', '}'])

/**
 * Splits the argument list that starts at `openIndex` (the opening parenthesis)
 * into top-level argument texts. Returns null when the list is unterminated.
 * String and template literals are skipped so a comma or bracket inside a
 * literal never splits an argument.
 */
function splitCallArguments(source, openIndex) {
  const stack = [')']
  const args = []
  let current = ''
  for (let index = openIndex + 1; index < source.length; index += 1) {
    const character = source[index]
    if (character === '\\') {
      current += character + (source[index + 1] ?? '')
      index += 1
      continue
    }
    if (character === "'" || character === '"' || character === '`') {
      const end = source.indexOf(character, index + 1)
      const quoted = end === -1 ? source.slice(index) : source.slice(index, end + 1)
      current += quoted
      index += quoted.length - 1
      continue
    }
    if (OPENERS[character]) {
      stack.push(OPENERS[character])
      current += character
      continue
    }
    if (CLOSERS.has(character)) {
      if (stack[stack.length - 1] !== character) return null
      stack.pop()
      if (stack.length === 0) {
        args.push(current)
        return args
      }
      current += character
      continue
    }
    if (character === ',' && stack.length === 1) {
      args.push(current)
      current = ''
      continue
    }
    current += character
  }
  return null
}

function literalValue(argumentText) {
  const match = /^\s*(['"])([^'"]+)\1\s*$/.exec(argumentText ?? '')
  return match ? match[2] : null
}

/**
 * Matches `name`, an optional generic clause, and the opening parenthesis.
 * The generic body allows `;` and newlines (object type literals span both) but
 * never parentheses, which keeps a malformed match from running past the call.
 */
function callSites(source, functionName) {
  const opening = new RegExp(`\\b${functionName}\\s*(?:<[^()]*?>\\s*)?\\(`, 'g')
  const sites = []
  for (const match of source.matchAll(opening)) {
    sites.push(match.index + match[0].length - 1)
  }
  return sites
}

function collectLiteralInvocations(source, functionName, argumentIndex = 0) {
  const commands = new Set()
  for (const openIndex of callSites(source, functionName)) {
    const args = splitCallArguments(source, openIndex)
    if (!args) continue
    const command = literalValue(args[argumentIndex])
    if (command) commands.add(command)
  }
  return commands
}

function collectForwardedInvocations(source) {
  const commands = new Set()
  for (const forwarder of COMMAND_FORWARDERS) {
    for (const command of collectLiteralInvocations(source, forwarder.name, forwarder.argumentIndex)) {
      commands.add(command)
    }
  }
  return commands
}

/**
 * Commands invoked through tauriInvoke are available to both renderers.
 * Calls through legacyTauriInvoke are compile-time/runtime gated to the LAN build.
 */
export function collectInvokedCommandSets(source) {
  const common = new Set([
    ...collectLiteralInvocations(source, 'tauriInvoke'),
    ...collectLiteralInvocations(source, 'invoke'),
    ...collectForwardedInvocations(source),
  ])
  const legacyOnly = collectLiteralInvocations(source, 'legacyTauriInvoke')
  return {
    matrix: common,
    legacy: new Set([...common, ...legacyOnly]),
  }
}

export function collectInvokedCommands(source) {
  return collectInvokedCommandSets(source).legacy
}

function commandsFromHandler(handlerSource) {
  const commands = new Set()
  const commandPath = /\bcommands(?:::[A-Za-z_][A-Za-z0-9_]*)+::([A-Za-z_][A-Za-z0-9_]*)\b/g
  for (const match of handlerSource.matchAll(commandPath)) commands.add(match[1])
  return commands
}

export function collectRegisteredCommandSets(source) {
  const matrixMatch = source.match(
    /#\[cfg\(not\(feature = "legacy-p2p"\)\)\]\s*let builder\s*=\s*builder\.invoke_handler\(tauri::generate_handler!\s*\[([\s\S]*?)\]\s*\)/,
  )
  const legacyMatch = source.match(
    /#\[cfg\(feature = "legacy-p2p"\)\]\s*let builder\s*=\s*builder\.invoke_handler\(tauri::generate_handler!\s*\[([\s\S]*?)\]\s*\)/,
  )
  if (!matrixMatch || !legacyMatch) {
    throw new Error('Expected explicit Matrix and legacy-p2p generate_handler! inventories')
  }
  return {
    matrix: commandsFromHandler(matrixMatch[1]),
    legacy: commandsFromHandler(legacyMatch[1]),
  }
}

export function collectRegisteredCommands(source) {
  const sets = collectRegisteredCommandSets(source)
  return new Set([...sets.matrix, ...sets.legacy])
}

export function collectAllowedCommands(source) {
  const commands = new Set()
  const allowList = /commands\.allow\s*=\s*\[([\s\S]*?)\]/g
  for (const list of source.matchAll(allowList)) {
    for (const match of list[1].matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)) {
      commands.add(match[1])
    }
  }
  return commands
}

export function findInvocationDrift(bridgeSource, rustSource) {
  const invoked = collectInvokedCommandSets(bridgeSource)
  const registered = collectRegisteredCommandSets(rustSource)
  return Object.fromEntries(
    BUILDS.map((build) => [
      build,
      [...invoked[build]].filter((command) => !registered[build].has(command)).sort(),
    ]),
  )
}

export function findUnregisteredCommands(bridgeSource, rustSource) {
  const drift = findInvocationDrift(bridgeSource, rustSource)
  return [...new Set([...drift.matrix, ...drift.legacy])].sort()
}

/**
 * The reverse of {@link findInvocationDrift}: handlers that are compiled into a
 * build and permitted for its renderer, but that no renderer call site reaches.
 *
 * This is the check that would have caught `matrix_create_community` going
 * invisible when its call site grew a multi-line generic clause. It also keeps
 * withdrawn features from leaving a live command behind.
 */
export function findUninvokedCommands(bridgeSource, rustSource, allowlist = UNINVOKED_COMMANDS) {
  const invoked = collectInvokedCommandSets(bridgeSource)
  const registered = collectRegisteredCommandSets(rustSource)
  return Object.fromEntries(
    BUILDS.map((build) => [
      build,
      [...registered[build]]
        .filter((command) => !invoked[build].has(command) && !(command in allowlist))
        .sort(),
    ]),
  )
}

/** Allowlist entries that no longer describe a registered command. */
export function findStaleUninvokedAllowlist(rustSource, allowlist = UNINVOKED_COMMANDS) {
  const registered = collectRegisteredCommands(rustSource)
  return Object.keys(allowlist).filter((command) => !registered.has(command)).sort()
}

/**
 * Matches a `#[tauri::command]` attribute, any attributes stacked under it, and
 * the name of the function it decorates.
 */
const COMMAND_DEFINITION =
  /#\[\s*tauri::command[^\]]*\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/g

/**
 * Every `#[tauri::command]` in the tree, mapped to the file that defines it.
 *
 * `sources` is an array of `{ path, source }`.
 */
export function collectDefinedCommands(sources) {
  const defined = new Map()
  for (const { path: filePath, source } of sources) {
    for (const match of source.matchAll(COMMAND_DEFINITION)) {
      if (!defined.has(match[1])) defined.set(match[1], filePath)
    }
  }
  return defined
}

/**
 * Commands that are defined but appear in neither handler inventory.
 *
 * The three drift checks above all enumerate *registered* commands, so none of
 * them can see a command that was never registered -- which is how
 * `commands/migration.rs` sat in the tree declaring four commands while being
 * compiled by nothing, its module declaration absent from `commands/mod.rs`.
 * Nothing reported it, and adding that one line would have activated all four
 * silently. The inventories are the union of both builds, so a command gated to
 * one feature still belongs to one of them.
 *
 * Assumes no `#[tauri::command]` is ever defined inside a `#[cfg(test)]` module.
 * None is today, and a test-only command would be a strange thing to want; if
 * one ever appears this check will ask for it to be registered.
 */
export function findUnregisteredDefinitions(definedCommands, rustSource) {
  const registered = collectRegisteredCommands(rustSource)
  return [...definedCommands.entries()]
    .filter(([command]) => !registered.has(command))
    .map(([command, filePath]) => `${command} (${filePath})`)
    .sort()
}

export async function collectRustSources(directory) {
  const sources = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      sources.push(...(await collectRustSources(entryPath)))
    } else if (entry.name.endsWith('.rs')) {
      sources.push({ path: entryPath, source: await readFile(entryPath, 'utf8') })
    }
  }
  return sources
}

export function findPermissionDrift(rustSource, permissionSources) {
  const registered = collectRegisteredCommandSets(rustSource)
  const matrixAllowed = collectAllowedCommands(permissionSources.matrix)
  const legacyAllowed = new Set([
    ...matrixAllowed,
    ...collectAllowedCommands(permissionSources.legacy),
  ])
  const allowed = { matrix: matrixAllowed, legacy: legacyAllowed }
  return Object.fromEntries(
    BUILDS.map((build) => [
      build,
      {
        missing: [...registered[build]].filter((command) => !allowed[build].has(command)).sort(),
        stale: [...allowed[build]].filter((command) => !registered[build].has(command)).sort(),
      },
    ]),
  )
}

export function findCapabilityDrift(sources) {
  const matrixCapability = JSON.parse(sources.matrixCapability)
  const legacyCapability = JSON.parse(sources.legacyCapability)
  const matrixConfig = JSON.parse(sources.matrixConfig)
  const legacyConfig = JSON.parse(sources.legacyConfig)
  const errors = []
  if (!matrixCapability.permissions?.includes('mesh-main')) {
    errors.push('The Matrix capability does not grant mesh-main')
  }
  if (matrixCapability.permissions?.includes('mesh-legacy')) {
    errors.push('The Matrix capability must never grant mesh-legacy')
  }
  if (
    !legacyCapability.permissions?.includes('mesh-main')
    || !legacyCapability.permissions?.includes('mesh-legacy')
  ) {
    errors.push('The legacy capability must grant both mesh-main and mesh-legacy')
  }
  const matrixSelection = matrixConfig.app?.security?.capabilities
  if (!Array.isArray(matrixSelection) || matrixSelection.length !== 1 || matrixSelection[0] !== 'default') {
    errors.push('The Matrix Tauri config does not select only the default capability')
  }
  const legacySelection = legacyConfig.app?.security?.capabilities
  if (!Array.isArray(legacySelection) || legacySelection.length !== 1 || legacySelection[0] !== 'legacy') {
    errors.push('The legacy Tauri config does not select only the legacy capability')
  }
  return errors
}

async function main() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const [bridgeSource, rustSource, matrixPermission, legacyPermission, buildSource, matrixCapability, legacyCapability, matrixConfig, legacyConfig] = await Promise.all([
    readFile(path.join(projectRoot, 'src', 'lib', 'bridge.ts'), 'utf8'),
    readFile(path.join(projectRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8'),
    readFile(path.join(projectRoot, 'src-tauri', 'permissions', 'mesh-main.toml'), 'utf8'),
    readFile(path.join(projectRoot, 'src-tauri', 'permissions', 'mesh-legacy.toml'), 'utf8'),
    readFile(path.join(projectRoot, 'src-tauri', 'build.rs'), 'utf8'),
    readFile(path.join(projectRoot, 'src-tauri', 'capabilities', 'default.json'), 'utf8'),
    readFile(path.join(projectRoot, 'src-tauri', 'capabilities', 'legacy.json'), 'utf8'),
    readFile(path.join(projectRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'),
    readFile(path.join(projectRoot, 'src-tauri', 'tauri.legacy.conf.json'), 'utf8'),
  ])
  const invocationDrift = findInvocationDrift(bridgeSource, rustSource)
  const permissionDrift = findPermissionDrift(rustSource, {
    matrix: matrixPermission,
    legacy: legacyPermission,
  })
  const uninvoked = findUninvokedCommands(bridgeSource, rustSource)
  const rustSources = await collectRustSources(path.join(projectRoot, 'src-tauri', 'src'))
  const definedCommands = collectDefinedCommands(
    rustSources.map(({ path: filePath, source }) => ({
      path: path.relative(projectRoot, filePath),
      source,
    })),
  )
  const errors = findCapabilityDrift({
    matrixCapability,
    legacyCapability,
    matrixConfig,
    legacyConfig,
  })

  const unregisteredDefinitions = findUnregisteredDefinitions(definedCommands, rustSource)
  if (unregisteredDefinitions.length > 0) {
    errors.push(
      `commands defined but present in neither handler inventory:\n- ${unregisteredDefinitions.join('\n- ')}\n`
      + '  A command no inventory names is compiled by nothing and reported by no other\n'
      + '  drift check, because they all enumerate registered commands. Register it or\n'
      + '  delete it.',
    )
  }

  const staleAllowlist = findStaleUninvokedAllowlist(rustSource)
  if (staleAllowlist.length > 0) {
    errors.push(`UNINVOKED_COMMANDS names commands that are no longer registered:\n- ${staleAllowlist.join('\n- ')}`)
  }

  for (const build of BUILDS) {
    if (invocationDrift[build].length > 0) {
      errors.push(`${build} renderer commands without compiled handlers:\n- ${invocationDrift[build].join('\n- ')}`)
    }
    if (uninvoked[build].length > 0) {
      errors.push(
        `${build} handlers that no renderer call site reaches:\n- ${uninvoked[build].join('\n- ')}\n`
        + '  Either wire the command up, withdraw it from the handler inventory and its\n'
        + '  permissions, declare its forwarding helper in COMMAND_FORWARDERS, or record\n'
        + '  it in UNINVOKED_COMMANDS with a reason.',
      )
    }
    if (permissionDrift[build].missing.length > 0) {
      errors.push(`${build} handlers missing from its renderer permissions:\n- ${permissionDrift[build].missing.join('\n- ')}`)
    }
    if (permissionDrift[build].stale.length > 0) {
      errors.push(`${build} renderer permissions contain stale commands:\n- ${permissionDrift[build].stale.join('\n- ')}`)
    }
  }
  if (!buildSource.includes('AppManifest::new().commands(application_commands())')) {
    errors.push('build.rs does not enable the explicit application command manifest')
  }
  for (const inventory of ['permissions/mesh-main.toml', 'permissions/mesh-legacy.toml']) {
    if (!buildSource.includes(`include_str!("${inventory}")`)) {
      errors.push(`build.rs does not include ${inventory}`)
    }
  }
  if (errors.length > 0) {
    console.error(`Tauri IPC contract check failed:\n- ${errors.join('\n- ')}`)
    process.exitCode = 1
    return
  }

  const invoked = collectInvokedCommandSets(bridgeSource)
  const allowed = Object.keys(UNINVOKED_COMMANDS).length
  console.log(
    `Tauri IPC contract check passed (Matrix ${invoked.matrix.size}; legacy ${invoked.legacy.size}; `
    + `every registered handler reachable except ${allowed} recorded in UNINVOKED_COMMANDS; `
    + `all ${definedCommands.size} defined commands registered; `
    + 'explicit per-build permissions active).',
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
