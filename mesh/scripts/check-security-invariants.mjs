import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rustRoot = path.join(appRoot, 'src-tauri', 'src')
const securityInvariantFunctions = Object.freeze([
  'compute_file_sha256',
  'encrypted_room_initial_state',
  'ensure_room_is_encrypted',
  'require_protected_room',
  'validate_attachment_payload',
])

async function rustSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return rustSourceFiles(entryPath)
    return entry.isFile() && entry.name.endsWith('.rs') ? [entryPath] : []
  }))
  return nested.flat()
}

function sourceDefinesFunction(source, functionName) {
  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\bfn\\s+${escaped}\\b`).test(source)
}

if (sourceDefinesFunction('fn real_security_gate() {}', 'fictional_security_gate')) {
  throw new Error('Security-invariant checker self-test failed')
}

const sourceFiles = await rustSourceFiles(rustRoot)
const sources = await Promise.all(sourceFiles.map(async (filePath) => ({
  filePath,
  source: await readFile(filePath, 'utf8'),
})))

const missing = securityInvariantFunctions.filter((functionName) => (
  !sources.some(({ source }) => sourceDefinesFunction(source, functionName))
))

if (missing.length > 0) {
  console.error('Security invariant check failed:')
  for (const functionName of missing) {
    console.error(`- ${functionName}() has no Rust definition`)
  }
  process.exitCode = 1
} else {
  console.log(
    `Security invariant check passed: ${securityInvariantFunctions.map((name) => `${name}()`).join(', ')} resolve to Rust definitions.`,
  )
}
