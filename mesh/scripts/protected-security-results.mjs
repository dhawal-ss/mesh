import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const outputPath = resolve(scriptDirectory, '..', 'release', 'security-run-results.json')
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const REQUIRED_KEYS = Object.freeze([
  'codeql',
  'dependencyReview',
  'featureMatrix',
  'dependencyAudit',
  'sbom',
  'r2Containers',
])

export function validateProtectedSecurityResults(results, { eventName, sourceSha } = {}) {
  const errors = []
  const keys = results && typeof results === 'object' && !Array.isArray(results)
    ? Object.keys(results).sort()
    : []
  if (keys.join('\n') !== [...REQUIRED_KEYS].sort().join('\n')) {
    return ['protected security results must contain the exact required job keys']
  }
  if (!SHA_PATTERN.test(sourceSha ?? '')) errors.push('protected security results require an exact source SHA')
  if (!['push', 'pull_request'].includes(eventName)) errors.push('protected security results require a supported workflow event')

  for (const [name, result] of Object.entries(results)) {
    const expected = name === 'dependencyReview' && eventName === 'push' ? 'skipped' : 'success'
    if (result !== expected) errors.push(`${name} must be ${expected}, received ${String(result)}`)
  }
  return errors
}

export async function main(env = process.env) {
  const results = {
    codeql: env.CODEQL,
    dependencyReview: env.DEPENDENCY_REVIEW,
    featureMatrix: env.FEATURE_MATRIX,
    dependencyAudit: env.DEPENDENCY_AUDIT,
    sbom: env.SBOM,
    r2Containers: env.R2_CONTAINERS,
  }
  const document = { schemaVersion: 1, sourceSha: env.GITHUB_SHA, results }
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')

  const errors = validateProtectedSecurityResults(results, {
    eventName: env.GITHUB_EVENT_NAME,
    sourceSha: env.GITHUB_SHA,
  })
  if (errors.length > 0) {
    console.error('Protected security result validation failed:')
    for (const error of errors) console.error(`- ${error}`)
    return 1
  }
  console.log(`Protected security results passed for ${env.GITHUB_EVENT_NAME}.`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
