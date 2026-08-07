import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const BUILDS = ['matrix', 'legacy']

function collectLiteralInvocations(source, functionName) {
  const commands = new Set()
  const invocation = new RegExp(
    `\\b${functionName}(?:<[^;\\n()]*>)?\\s*\\(\\s*(['"])([^'"]+)\\1`,
    'g',
  )
  for (const match of source.matchAll(invocation)) commands.add(match[2])
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
  const errors = findCapabilityDrift({
    matrixCapability,
    legacyCapability,
    matrixConfig,
    legacyConfig,
  })

  for (const build of BUILDS) {
    if (invocationDrift[build].length > 0) {
      errors.push(`${build} renderer commands without compiled handlers:\n- ${invocationDrift[build].join('\n- ')}`)
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
  console.log(`Tauri IPC contract check passed (Matrix ${invoked.matrix.size}; legacy ${invoked.legacy.size}; explicit per-build permissions active).`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
