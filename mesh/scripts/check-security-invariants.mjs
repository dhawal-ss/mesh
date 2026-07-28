import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = path.resolve(appRoot, '..')
const agentsPath = path.join(repositoryRoot, 'AGENTS.md')
const rustRoot = path.join(appRoot, 'src-tauri', 'src')

function securityInvariantSection(markdown) {
  const header = '## Security invariants'
  const start = markdown.indexOf(header)
  if (start === -1) {
    throw new Error('AGENTS.md must contain a Security invariants section')
  }
  const body = markdown.slice(start + header.length)
  const nextSection = body.search(/\n##\s/)
  return nextSection === -1 ? body : body.slice(0, nextSection)
}

function namedLocalFunctions(markdown) {
  const functions = new Set()
  for (const codeSpan of securityInvariantSection(markdown).matchAll(/`([^`\r\n]+)`/g)) {
    for (const call of codeSpan[1].matchAll(/\b([a-z][a-z0-9_]*)\(\)/g)) {
      functions.add(call[1])
    }
  }
  return [...functions].sort()
}

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

const fictionalInvariant = [
  '## Security invariants',
  '1. `fictional_security_gate()` protects this path.',
  '## Next section',
].join('\n')
if (
  namedLocalFunctions(fictionalInvariant).join(',') !== 'fictional_security_gate'
  || sourceDefinesFunction('fn real_security_gate() {}', 'fictional_security_gate')
) {
  throw new Error('Security-invariant checker self-test failed')
}

const [agents, sourceFiles] = await Promise.all([
  readFile(agentsPath, 'utf8'),
  rustSourceFiles(rustRoot),
])
const sources = await Promise.all(sourceFiles.map(async (filePath) => ({
  filePath,
  source: await readFile(filePath, 'utf8'),
})))
const functions = namedLocalFunctions(agents)

if (functions.length === 0) {
  throw new Error('Security invariants must name at least one local Rust function')
}

const missing = functions.filter((functionName) => (
  !sources.some(({ source }) => sourceDefinesFunction(source, functionName))
))

if (missing.length > 0) {
  console.error('Security invariant check failed:')
  for (const functionName of missing) {
    console.error(`- AGENTS.md names ${functionName}(), but no Rust definition exists`)
  }
  process.exitCode = 1
} else {
  console.log(
    `Security invariant check passed: ${functions.map((name) => `${name}()`).join(', ')} resolve to Rust definitions.`,
  )
}
