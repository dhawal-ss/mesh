import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve('src')
const SCANNED_EXTENSIONS = new Set(['.css', '.html', '.json', '.ts', '.tsx'])
const FORBIDDEN_MARKS = [
  { label: 'literal em dash', pattern: /—/u },
  { label: 'HTML em dash entity', pattern: /&(?:mdash|#8212|#x2014);/iu },
  { label: 'escaped em dash', pattern: /\\u2014/iu },
]

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collectFiles(fullPath))
    else if (SCANNED_EXTENSIONS.has(path.extname(entry.name))) files.push(fullPath)
  }
  return files
}

const findings = []
for (const file of await collectFiles(ROOT)) {
  const lines = (await readFile(file, 'utf8')).split(/\r?\n/u)
  lines.forEach((line, index) => {
    for (const mark of FORBIDDEN_MARKS) {
      if (mark.pattern.test(line)) {
        findings.push(`${path.relative(process.cwd(), file)}:${index + 1}: ${mark.label}`)
      }
    }
  })
}

if (findings.length > 0) {
  console.error('Mesh product copy must not contain em dashes.')
  findings.forEach((finding) => console.error(`  ${finding}`))
  process.exitCode = 1
} else {
  console.log('Copy style check passed: no em dashes found in renderer source.')
}
