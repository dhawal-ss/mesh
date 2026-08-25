import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const outputPath = resolve(scriptDirectory, '..', 'release', 'ci-run-results.json')
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const REQUIRED_KEYS = Object.freeze(['matrixRust', 'legacyRust', 'frontend'])

export function validateProtectedCiResults(results, { sourceSha } = {}) {
  if (!results || typeof results !== 'object' || Array.isArray(results)
      || Object.keys(results).sort().join('\n') !== [...REQUIRED_KEYS].sort().join('\n')) {
    return ['protected CI results must contain the exact required job keys']
  }
  const errors = []
  if (!SHA_PATTERN.test(sourceSha ?? '')) errors.push('protected CI results require an exact source SHA')
  for (const [name, result] of Object.entries(results)) {
    if (result !== 'success') errors.push(`${name} must be success, received ${String(result)}`)
  }
  return errors
}

export async function main(env = process.env) {
  const results = {
    matrixRust: env.MATRIX_RUST,
    legacyRust: env.LEGACY_RUST,
    frontend: env.FRONTEND,
  }
  const document = { schemaVersion: 1, sourceSha: env.GITHUB_SHA, results }
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')

  const errors = validateProtectedCiResults(results, { sourceSha: env.GITHUB_SHA })
  if (errors.length > 0) {
    console.error('Protected CI result validation failed:')
    for (const error of errors) console.error(`- ${error}`)
    return 1
  }
  console.log('Protected CI results passed.')
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
