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

export function findUnregisteredCommands(bridgeSource, rustSource) {
  const invoked = collectInvokedCommands(bridgeSource)
  const registered = collectRegisteredCommands(rustSource)
  return [...invoked].filter((command) => !registered.has(command)).sort()
}

async function main() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const [bridgeSource, rustSource] = await Promise.all([
    readFile(path.join(projectRoot, 'src', 'lib', 'bridge.ts'), 'utf8'),
    readFile(path.join(projectRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8'),
  ])
  const missing = findUnregisteredCommands(bridgeSource, rustSource)

  if (missing.length > 0) {
    console.error('Tauri IPC contract check failed. Frontend commands without registered handlers:')
    for (const command of missing) {
      console.error(`- ${command}`)
    }
    process.exitCode = 1
    return
  }

  console.log(`Tauri IPC contract check passed (${collectInvokedCommands(bridgeSource).size} commands).`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
