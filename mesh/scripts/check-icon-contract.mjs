import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const componentsRoot = path.join(repoRoot, 'src', 'components')
const centralRenderer = path.join(componentsRoot, 'ui', 'Icon.tsx')

function isTestFixture(filePath) {
  const normalized = filePath.replaceAll('\\', '/')
  return (
    /\.(?:test|spec|fixture)\.[cm]?[jt]sx?$/i.test(normalized)
    || normalized.includes('/__fixtures__/')
    || normalized.includes('/fixtures/')
  )
}

function violationsFor(source) {
  const violations = []
  if (/<svg\b/i.test(source)) violations.push('inline <svg> markup')
  if (/['"]lucide-react['"]/.test(source)) violations.push('direct lucide-react import')
  return violations
}

async function componentFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) return componentFiles(entryPath)
      return entry.isFile() && /\.tsx?$/i.test(entry.name) ? [entryPath] : []
    }),
  )
  return nested.flat()
}

// Guard the checker itself against accidental weakening.
if (
  violationsFor('<svg viewBox="0 0 24 24" />').length !== 1
  || violationsFor("import { Search } from 'lucide-react'").length !== 1
) {
  throw new Error('Icon contract checker self-test failed')
}

const errors = []
const rendererSource = await readFile(centralRenderer, 'utf8')
if (!/\babsoluteStrokeWidth\b/.test(rendererSource)) {
  errors.push('src/components/ui/Icon.tsx must opt into Lucide absoluteStrokeWidth')
}
if (!/size === ['"]lg['"] \? 1\.75 : 1\.5/.test(rendererSource)) {
  errors.push('src/components/ui/Icon.tsx must render 14–20px icons at 1.5px and 24px icons at 1.75px')
}

if (!/sm:\s*16[\s\S]*md:\s*18/.test(rendererSource)) {
  errors.push('src/components/ui/Icon.tsx must keep 16px utility and 18px primary Party Room icons')
}

for (const filePath of await componentFiles(componentsRoot)) {
  if (filePath === centralRenderer || isTestFixture(filePath)) continue
  const source = await readFile(filePath, 'utf8')
  for (const violation of violationsFor(source)) {
    errors.push(`${path.relative(repoRoot, filePath)} contains ${violation}`)
  }
}

if (errors.length > 0) {
  console.error(['Icon contract check failed:', ...errors.map((error) => `- ${error}`)].join('\n'))
  process.exit(1)
}

console.log(
  'Icon contract check passed: production components use the central 16px and 18px absolute-stroke Icon renderer without inline SVG.',
)
