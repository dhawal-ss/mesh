import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export function collectInvokedCommands(source) {
  const commands = new Set()
  const invocation = /\btauriInvoke(?:<[^;\n()]*>)?\s*\(\s*(['"])([^'"]+)\1/g
  for (const match of source.matchAll(invocation)) {
    commands.add(match[2])
  }
  return commands
}

export function collectRegisteredCommands(source) {
  const commands = new Set()
  const handlers = /generate_handler!\s*\[([\s\S]*?)\]\s*\)/g
  for (const handler of source.matchAll(handlers)) {
    const commandPath = /\bcommands(?:::[A-Za-z_][A-Za-z0-9_]*)+::([A-Za-z_][A-Za-z0-9_]*)\b/g
    for (const match of handler[1].matchAll(commandPath)) {
      commands.add(match[1])
    }
  }
  return commands
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

export function findUnregisteredCommands(bridgeSource, rustSource) {
  const invoked = collectInvokedCommands(bridgeSource)
  const registered = collectRegisteredCommands(rustSource)
  return [...invoked].filter((command) => !registered.has(command)).sort()
}

export function findPermissionDrift(rustSource, permissionSource) {
  const registered = collectRegisteredCommands(rustSource)
  const allowed = collectAllowedCommands(permissionSource)
  return {
    missing: [...registered].filter((command) => !allowed.has(command)).sort(),
    stale: [...allowed].filter((command) => !registered.has(command)).sort(),
  }
}

async function main() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const [bridgeSource, rustSource, permissionSource, buildSource, capabilitySource] = await Promise.all([
    readFile(path.join(projectRoot, 'src', 'lib', 'bridge.ts'), 'utf8'),
    readFile(path.join(projectRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8'),
    readFile(path.join(projectRoot, 'src-tauri', 'permissions', 'mesh-main.toml'), 'utf8'),
    readFile(path.join(projectRoot, 'src-tauri', 'build.rs'), 'utf8'),
    readFile(path.join(projectRoot, 'src-tauri', 'capabilities', 'default.json'), 'utf8'),
  ])
  const missing = findUnregisteredCommands(bridgeSource, rustSource)
  const permissionDrift = findPermissionDrift(rustSource, permissionSource)
  const errors = []

  if (missing.length > 0) {
    errors.push(`Frontend commands without registered handlers:\n- ${missing.join('\n- ')}`)
  }
  if (permissionDrift.missing.length > 0) {
    errors.push(`Registered commands missing from the renderer permission:\n- ${permissionDrift.missing.join('\n- ')}`)
  }
  if (permissionDrift.stale.length > 0) {
    errors.push(`Stale commands in the renderer permission:\n- ${permissionDrift.stale.join('\n- ')}`)
  }
  if (!buildSource.includes('AppManifest::new().commands(application_commands())')) {
    errors.push('build.rs does not enable the explicit application command manifest')
  }
  if (!buildSource.includes('include_str!("permissions/mesh-main.toml")')) {
    errors.push('build.rs does not use the reviewed renderer permission as its command inventory')
  }
  if (!JSON.parse(capabilitySource).permissions.includes('mesh-main')) {
    errors.push('The main WebView capability does not grant the reviewed mesh-main permission')
  }

  if (errors.length > 0) {
    console.error(`Tauri IPC contract check failed:\n- ${errors.join('\n- ')}`)
    process.exitCode = 1
    return
  }

  console.log(`Tauri IPC contract check passed (${collectInvokedCommands(bridgeSource).size} commands; explicit renderer permission active).`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
