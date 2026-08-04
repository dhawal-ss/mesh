import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FORBIDDEN_TEXT_PACKAGES = new Set(['simple-peer', 'livekit-client'])

function encodePurlComponent(value) {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%3A/gi, ':')
}

export function npmPackageUrl(name, version) {
  if (typeof name !== 'string' || !name || typeof version !== 'string' || !version) {
    throw new TypeError('npm Package URLs require a package name and version')
  }
  const versionComponent = encodePurlComponent(version)
  if (!name.startsWith('@')) {
    if (name.includes('/')) throw new TypeError(`invalid unscoped npm package name: ${name}`)
    return `pkg:npm/${encodePurlComponent(name)}@${versionComponent}`
  }
  const segments = name.split('/')
  if (segments.length !== 2 || segments.some((segment) => !segment)) {
    throw new TypeError(`invalid scoped npm package name: ${name}`)
  }
  return `pkg:npm/${encodePurlComponent(segments[0])}/${encodePurlComponent(segments[1])}@${versionComponent}`
}

function npmComponents(lock, graph) {
  const components = []
  for (const [packagePath, metadata] of Object.entries(lock.packages ?? {})) {
    const marker = 'node_modules/'
    const index = packagePath.lastIndexOf(marker)
    if (index < 0 || !metadata.version) continue
    const name = packagePath.slice(index + marker.length)
    components.push({
      type: 'library',
      name,
      version: metadata.version,
      purl: npmPackageUrl(name, metadata.version),
      properties: [{ name: 'mesh:dependency-graph', value: graph }],
    })
  }
  return components
}

function cargoMetadata(projectRoot, features) {
  const output = execFileSync('cargo', [
    'metadata', '--format-version', '1', '--locked', '--filter-platform', 'x86_64-pc-windows-msvc',
    '--manifest-path', path.join(projectRoot, 'src-tauri', 'Cargo.toml'),
    '--no-default-features', '--features', features,
  ], { cwd: projectRoot, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  return JSON.parse(output)
}

function cargoComponents(metadata, graph) {
  const reachable = new Set((metadata.resolve?.nodes ?? []).map((node) => node.id))
  return metadata.packages
    .filter((pkg) => reachable.has(pkg.id))
    .map((pkg) => ({
      type: 'library',
      name: pkg.name,
      version: pkg.version,
      purl: `pkg:cargo/${pkg.name}@${pkg.version}`,
      properties: [{ name: 'mesh:dependency-graph', value: graph }],
    }))
}

function deduplicate(components) {
  const byKey = new Map()
  for (const component of components) {
    const key = `${component.purl}|${component.properties?.[0]?.value ?? ''}`
    if (!byKey.has(key)) byKey.set(key, component)
  }
  return [...byKey.values()].sort((left, right) => left.purl.localeCompare(right.purl))
}

function bom(name, components, metadata) {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: { type: 'application', name: 'Mesh', version: metadata.version },
      properties: [
        { name: 'mesh:inventory', value: name },
        { name: 'mesh:source-commit', value: metadata.sourceCommit },
        { name: 'mesh:source-tree-hash', value: metadata.sourceTreeHash },
        { name: 'mesh:clean-source', value: String(metadata.cleanSource) },
      ],
    },
    components: deduplicate(components),
  }
}

export function validateSbomBoundary(sourceBom, artifactBom) {
  const sourceNames = new Set(sourceBom.components.map((component) => component.name))
  const artifactNames = new Set(artifactBom.components.map((component) => component.name))
  const errors = []
  for (const forbidden of FORBIDDEN_TEXT_PACKAGES) {
    if (!sourceNames.has(forbidden)) errors.push(`complete source inventory is missing ${forbidden}`)
    if (artifactNames.has(forbidden)) errors.push(`Matrix text artifact inventory contains forbidden ${forbidden}`)
  }
  return errors
}

export async function generateReleaseSboms({ projectRoot, reachabilityPath, sourceOutput, artifactOutput }) {
  const lockInputs = [
    ['text', 'package-lock.json'],
    ['matrix-voice', 'feature-deps/matrix-voice/package-lock.json'],
    ['legacy-lan', 'feature-deps/legacy-lan/package-lock.json'],
  ]
  const locks = await Promise.all(lockInputs.map(async ([graph, lockPath]) => [graph, JSON.parse(await readFile(path.join(projectRoot, lockPath), 'utf8'))]))
  const reachability = JSON.parse(await readFile(reachabilityPath, 'utf8'))
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'))
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8', windowsHide: true }).trim()
  const sourceTreeHash = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: projectRoot, encoding: 'utf8', windowsHide: true }).trim()
  const cleanSource = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: projectRoot, encoding: 'utf8', windowsHide: true }).trim() === ''
  const matrixCargo = cargoMetadata(projectRoot, 'matrix-backend')
  const legacyCargo = cargoMetadata(projectRoot, 'legacy-p2p')
  const allNpm = locks.flatMap(([graph, lock]) => npmComponents(lock, graph))
  const npmByName = new Map(allNpm.map((component) => [component.name, component]))
  const missingReachable = reachability.packages.filter((name) => !npmByName.has(name))
  if (missingReachable.length) throw new Error(`Reachable packages are absent from reviewed lock graphs: ${missingReachable.join(', ')}`)
  const metadata = { version: packageJson.version, sourceCommit, sourceTreeHash, cleanSource }
  const sourceBom = bom('complete-source-lockfile', [
    ...allNpm,
    ...cargoComponents(matrixCargo, 'matrix-backend'),
    ...cargoComponents(legacyCargo, 'legacy-p2p'),
  ], metadata)
  const artifactBom = bom('matrix-windows-artifact-reachability', [
    ...reachability.packages.map((name) => npmByName.get(name)),
    ...cargoComponents(matrixCargo, 'matrix-backend'),
  ], metadata)
  const errors = validateSbomBoundary(sourceBom, artifactBom)
  if (errors.length) throw new Error(errors.join('; '))
  await Promise.all([sourceOutput, artifactOutput].map((output) => mkdir(path.dirname(output), { recursive: true })))
  await Promise.all([
    writeFile(sourceOutput, `${JSON.stringify(sourceBom, null, 2)}\n`, 'utf8'),
    writeFile(artifactOutput, `${JSON.stringify(artifactBom, null, 2)}\n`, 'utf8'),
  ])
  console.log(`Release SBOMs generated (source ${sourceBom.components.length}; Matrix artifact ${artifactBom.components.length}).`)
  return { sourceBom, artifactBom }
}

async function main() {
  const args = new Map()
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1])
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  await generateReleaseSboms({
    projectRoot,
    reachabilityPath: path.resolve(projectRoot, args.get('--reachability') ?? 'dist/mesh-reachability.json'),
    sourceOutput: path.resolve(projectRoot, args.get('--source-output') ?? 'release/source-lockfile.cdx.json'),
    artifactOutput: path.resolve(projectRoot, args.get('--artifact-output') ?? 'release/matrix-windows-artifact.cdx.json'),
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
