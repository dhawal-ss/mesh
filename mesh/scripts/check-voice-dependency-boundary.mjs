import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function lockHas(lock, name) {
  return Object.prototype.hasOwnProperty.call(lock.packages ?? {}, `node_modules/${name}`)
}

export function validateVoiceDependencyGraphs({ rootPackage, rootLock, matrixVoiceLock, legacyLock }) {
  const errors = []
  for (const name of ['simple-peer', 'livekit-client']) {
    if (rootPackage.dependencies?.[name] || rootPackage.devDependencies?.[name]) errors.push(`root package declares ${name}`)
    if (lockHas(rootLock, name)) errors.push(`root lock graph installs ${name}`)
  }
  if (!lockHas(matrixVoiceLock, 'livekit-client')) errors.push('Matrix voice lock graph is missing livekit-client')
  if (lockHas(matrixVoiceLock, 'simple-peer')) errors.push('Matrix voice lock graph contains simple-peer')
  if (!lockHas(legacyLock, 'simple-peer')) errors.push('legacy LAN lock graph is missing simple-peer')
  if (lockHas(legacyLock, 'livekit-client')) errors.push('legacy LAN lock graph contains livekit-client')
  return errors
}

async function exists(candidate) {
  try { await access(candidate); return true } catch { return false }
}

async function main() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const [rootPackage, rootLock, matrixVoiceLock, legacyLock, vite, packageText] = await Promise.all([
    readFile(path.join(projectRoot, 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(projectRoot, 'package-lock.json'), 'utf8').then(JSON.parse),
    readFile(path.join(projectRoot, 'feature-deps', 'matrix-voice', 'package-lock.json'), 'utf8').then(JSON.parse),
    readFile(path.join(projectRoot, 'feature-deps', 'legacy-lan', 'package-lock.json'), 'utf8').then(JSON.parse),
    readFile(path.join(projectRoot, 'vite.config.ts'), 'utf8'),
    readFile(path.join(projectRoot, 'package.json'), 'utf8'),
  ])
  const errors = validateVoiceDependencyGraphs({ rootPackage, rootLock, matrixVoiceLock, legacyLock })
  for (const name of ['simple-peer', 'livekit-client']) {
    if (await exists(path.join(projectRoot, 'node_modules', name))) errors.push(`default installed graph contains ${name}`)
  }
  for (const contract of ['@mesh/matrix-voice-runtime', '@mesh/legacy-voice-runtime']) {
    if (!vite.includes(contract)) errors.push(`Vite is missing ${contract} feature alias`)
  }
  for (const script of ['install:matrix-voice-deps', 'install:lan-voice-deps', 'test:voice-features']) {
    if (!packageText.includes(`"${script}"`)) errors.push(`package scripts are missing ${script}`)
  }
  if (errors.length) throw new Error(errors.join('; '))
  console.log('Voice dependency boundary passed (text, Matrix voice, and LAN lock graphs are independent).')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
