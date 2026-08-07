import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function deriveReleaseIntent({ eventName, ref = '', releaseTag = '', validationOnly = false }) {
  if (eventName === 'push' && ref === 'refs/heads/main') {
    return { mode: 'validation-only', createCandidate: false, releaseTag: '' }
  }
  if (eventName === 'push' && ref.startsWith('refs/tags/v')) {
    return { mode: 'candidate', createCandidate: true, releaseTag: ref.slice('refs/tags/'.length) }
  }
  if (eventName !== 'workflow_dispatch') throw new Error('Unsupported release-factory event')
  if (validationOnly && releaseTag) throw new Error('Validation-only runs cannot name a release tag')
  if (validationOnly) return { mode: 'validation-only', createCandidate: false, releaseTag: '' }
  if (!releaseTag) throw new Error('A non-validation manual run requires an explicit release tag')
  return { mode: 'candidate', createCandidate: true, releaseTag }
}

function cargoVersion(source) {
  const match = source.match(/\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)
  if (!match) throw new Error('Cargo package version is missing')
  return match[1]
}

export async function createValidationInventory({ projectRoot, sourceSha, treeHash, outputPath }) {
  if (!/^[0-9a-f]{40}$/.test(sourceSha) || !/^[0-9a-f]{40}$/.test(treeHash)) {
    throw new Error('Validation inventory requires exact source and tree hashes')
  }
  const [packageJson, tauriJson, cargoToml] = await Promise.all([
    readFile(path.join(projectRoot, 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(projectRoot, 'src-tauri', 'tauri.conf.json'), 'utf8').then(JSON.parse),
    readFile(path.join(projectRoot, 'src-tauri', 'Cargo.toml'), 'utf8'),
  ])
  const versions = [packageJson.version, tauriJson.version, cargoVersion(cargoToml)]
  if (!versions.every((version) => version === versions[0])) throw new Error('Application versions are inconsistent')
  const inventory = {
    schemaVersion: 1,
    mode: 'validation-only',
    sourceSha,
    sourceTreeHash: treeHash,
    releaseVersion: versions[0],
    permissions: 'read-only',
    secretAccess: false,
    signingPerformed: false,
    candidateBinaryProduced: false,
    publicationPerformed: false,
    wouldBuild: [
      'windows-msi',
      'windows-nsis',
      'source-lockfile.cdx.json',
      'matrix-windows-artifact.cdx.json',
      'THIRD_PARTY_NOTICES.md',
      'LICENSE',
      'COPYRIGHT',
      'exact-source.json',
      'SHA256SUMS.txt',
      'provenance.json',
    ],
  }
  const serialized = `${JSON.stringify(inventory, null, 2)}\n`
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, serialized, 'utf8')
  return { ...inventory, inventorySha256: createHash('sha256').update(serialized).digest('hex') }
}

async function main() {
  const args = new Map()
  for (let index = 2; index < process.argv.length; index += 2) {
    args.set(process.argv[index], process.argv[index + 1])
  }
  if (!args.has('--validation-only')) throw new Error('Explicit --validation-only is required')
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const outputPath = path.resolve(projectRoot, args.get('--output') ?? 'release/release-factory-validation.json')
  const result = await createValidationInventory({
    projectRoot,
    sourceSha: args.get('--source-sha') ?? '',
    treeHash: args.get('--tree-hash') ?? '',
    outputPath,
  })
  console.log(`Release-factory validation inventory passed (${result.wouldBuild.length} planned assets; no binary, secret, signing, or publication).`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
