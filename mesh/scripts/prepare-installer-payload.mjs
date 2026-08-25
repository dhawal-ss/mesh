import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export async function verifyOfflineLegalPayload(projectRoot) {
  const config = JSON.parse(await readFile(path.join(projectRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'))
  const resources = new Set(config.bundle?.resources ?? [])
  const expected = ['../../LICENSE', '../../COPYRIGHT', '../THIRD_PARTY_NOTICES.md', '../release/installer-payload/']
  const missing = expected.filter((resource) => !resources.has(resource))
  if (missing.length) throw new Error(`Installer resources are missing: ${missing.join(', ')}`)
  for (const file of [
    path.resolve(projectRoot, '..', 'LICENSE'),
    path.resolve(projectRoot, '..', 'COPYRIGHT'),
    path.join(projectRoot, 'THIRD_PARTY_NOTICES.md'),
  ]) await readFile(file)
  return expected
}

export async function prepareInstallerPayload({ projectRoot, tag, validationOnly = false }) {
  await verifyOfflineLegalPayload(projectRoot)
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'))
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8', windowsHide: true }).trim()
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: projectRoot, encoding: 'utf8', windowsHide: true }).trim()
  if (!validationOnly) {
    if (packageJson.version === '0.1.0' || tag !== `v${packageJson.version}`) throw new Error('Candidate payload requires a non-placeholder exact version tag')
    const tagCommit = execFileSync('git', ['rev-parse', `${tag}^{commit}`], { cwd: projectRoot, encoding: 'utf8', windowsHide: true }).trim()
    if (tagCommit !== commit) throw new Error('Candidate payload tag does not resolve to HEAD')
  }
  const payloadRoot = path.join(projectRoot, 'release', 'installer-payload')
  await mkdir(payloadRoot, { recursive: true })
  for (const name of ['source-lockfile.cdx.json', 'matrix-windows-artifact.cdx.json', 'exact-source.json']) {
    await rm(path.join(payloadRoot, name), { force: true })
  }
  await Promise.all([
    copyFile(path.join(projectRoot, 'release', 'source-lockfile.cdx.json'), path.join(payloadRoot, 'source-lockfile.cdx.json')),
    copyFile(path.join(projectRoot, 'release', 'matrix-windows-artifact.cdx.json'), path.join(payloadRoot, 'matrix-windows-artifact.cdx.json')),
  ])
  const exactSource = {
    schemaVersion: 1,
    repository: 'https://github.com/dhawal-ss/mesh',
    tag: validationOnly ? null : tag,
    version: packageJson.version,
    sourceCommit: commit,
    sourceTreeHash: tree,
    validationOnly,
  }
  await writeFile(path.join(payloadRoot, 'exact-source.json'), `${JSON.stringify(exactSource, null, 2)}\n`, 'utf8')
  return exactSource
}

async function main() {
  const args = new Map()
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1])
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  if (args.has('--verify-only')) {
    await verifyOfflineLegalPayload(projectRoot)
    console.log('Offline installer legal resources are configured.')
    return
  }
  await prepareInstallerPayload({ projectRoot, tag: args.get('--tag') ?? '', validationOnly: args.has('--validation-only') })
  console.log('Installer SBOM/legal payload prepared.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
