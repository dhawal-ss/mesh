import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const budgets = Object.freeze({
  entryBytes: 350 * 1024,
  eagerJavaScriptBytes: 525 * 1024,
  individualJavaScriptBytes: 550 * 1024,
  // Matrix voice adds a lazy LiveKit client chunk plus its media-E2EE worker.
  // Keep the entry/eager/individual limits tight so voice never taxes startup.
  totalJavaScriptBytes: 2_150 * 1024,
  totalCssBytes: 100 * 1024,
  totalFontBytes: 400 * 1024,
  totalAssetBytes: 2_500 * 1024,
})
const assetsDirectory = new URL('../dist/assets/', import.meta.url)
const indexPath = new URL('../dist/index.html', import.meta.url)
const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const argumentsList = process.argv.slice(2)
let reportPath = null
for (let index = 0; index < argumentsList.length; index += 1) {
  if (argumentsList[index] !== '--report' || index + 1 >= argumentsList.length || reportPath) {
    throw new Error('Usage: node scripts/check-bundle-size.mjs [--report path.json]')
  }
  reportPath = resolve(argumentsList[index + 1])
  index += 1
}

const entries = (await readdir(assetsDirectory)).sort()
const entryChunks = entries.filter((name) => /^index-[^/]+\.js$/.test(name))

if (entryChunks.length !== 1) {
  throw new Error(`Expected exactly one frontend entry chunk, found ${entryChunks.length}.`)
}

const entryName = entryChunks[0]
const assetStats = await Promise.all(entries.map(async (name) => ({
  name,
  bytes: (await stat(join(fileURLToPath(assetsDirectory), name))).size,
})))
const entrySize = assetStats.find(({ name }) => name === entryName)?.bytes ?? 0
const indexHtml = await readFile(indexPath, 'utf8')
const eagerAssets = new Set(
  [...indexHtml.matchAll(/(?:src|href)=["']\/assets\/([^"'?#]+)["']/g)]
    .map((match) => match[1]),
)

const javascript = assetStats.filter(({ name }) => ['.js', '.mjs'].includes(extname(name)))
const css = assetStats.filter(({ name }) => extname(name) === '.css')
const fonts = assetStats.filter(({ name }) => ['.woff', '.woff2', '.ttf', '.otf'].includes(extname(name)))
const sum = (files) => files.reduce((total, file) => total + file.bytes, 0)
const formatKib = (bytes) => `${(bytes / 1024).toFixed(2)} KiB`
const failures = []

if (entrySize > budgets.entryBytes) {
  failures.push(
    `entry chunk ${entryName} is ${formatKib(entrySize)}; maximum is ${formatKib(budgets.entryBytes)}`,
  )
}

for (const file of javascript) {
  if (file.bytes > budgets.individualJavaScriptBytes) {
    failures.push(
      `JavaScript chunk ${file.name} is ${formatKib(file.bytes)}; maximum is ${formatKib(budgets.individualJavaScriptBytes)}`,
    )
  }
}

const eagerJavaScriptBytes = sum(javascript.filter(({ name }) => eagerAssets.has(name)))
const totals = [
  ['eager JavaScript', eagerJavaScriptBytes, budgets.eagerJavaScriptBytes],
  ['all JavaScript', sum(javascript), budgets.totalJavaScriptBytes],
  ['all CSS', sum(css), budgets.totalCssBytes],
  ['all fonts', sum(fonts), budgets.totalFontBytes],
  ['all production assets', sum(assetStats), budgets.totalAssetBytes],
]
for (const [label, bytes, limit] of totals) {
  if (bytes > limit) {
    failures.push(`${label} totals ${formatKib(bytes)}; maximum is ${formatKib(limit)}`)
  }
}

const report = {
  schemaVersion: 1,
  sourceSha: execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
  status: failures.length === 0 ? 'pass' : 'fail',
  entry: { name: entryName, bytes: entrySize, limit: budgets.entryBytes },
  totals: Object.fromEntries(totals.map(([label, bytes, limit]) => [label, { bytes, limit }])),
  javascriptChunks: javascript.map(({ name, bytes }) => ({
    name,
    bytes,
    eager: eagerAssets.has(name),
  })),
  failures,
}
if (reportPath) {
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

if (failures.length > 0) {
  throw new Error(`Production bundle budget failed:\n- ${failures.join('\n- ')}`)
}

console.log('Production bundle budgets passed:')
console.log(`- entry: ${entryName} at ${formatKib(entrySize)} / ${formatKib(budgets.entryBytes)}`)
for (const [label, bytes, limit] of totals) {
  console.log(`- ${label}: ${formatKib(bytes)} / ${formatKib(limit)}`)
}
