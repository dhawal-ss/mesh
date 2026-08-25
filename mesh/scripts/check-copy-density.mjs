import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/*
  Copy is a control surface, not a page.

  Mesh shipped 127 user-facing strings of two or more sentences, and almost none
  of the second sentences told anybody what to do: they explained how a feature
  worked, reassured the reader it was safe, or restated the label above them.
  That is the app talking about itself, and it is the difference between an
  interface somebody operates and a page somebody reads.

  The threshold is measured rather than chosen. Across the renderer the median
  prose string is 9 words and the ninetieth percentile is 16, so the tail is
  where the essays live, not the middle. Two short sentences are frequently the
  right shape for a failure ("That did not work. Try again."), so sentence count
  alone is the wrong test and would have banned the good pattern along with the
  bad one. Length is the honest signal.

  This does not measure whether copy is good. It measures whether Mesh is
  explaining itself, which is the failure mode it actually has.
*/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = path.join(root, 'src')

/*
 * Measured against the renderer: median 9 words, ninetieth percentile 16. The
 * limit sits at the ninetieth percentile so it bites the tail rather than the
 * middle, and two sentences stay legal because "That did not work. Try again."
 * is the right shape for a failure.
 */
export const MAXIMUM_WORDS = 16
export const MAXIMUM_SENTENCES = 2

/**
 * Copy allowed past the limits, and the fact a reader would lose without it.
 *
 * A consequence somebody cannot undo can earn the words. An explanation of how
 * Mesh works cannot. Both entries here are governed owner decisions rather than
 * editorial judgement.
 */
export const ALLOWED_LONG_COPY = new Map([
  ['recovery-copy-disclosure', 'Owner decision D20: the Windows recovery-copy warning must say that somebody able to use the Windows account may be able to ask Mesh to use the copy.'],
  ['message-deletion-confirmation', 'Owner decision D16: deleting your own message confirms, and says the deletion cannot be undone.'],
])

/** Exact strings this gate permits past the limits, keyed to the reason above. */
export const ALLOWED_STRINGS = new Set([
  // recovery-copy-disclosure. Names the mechanism and the specific risk, and
  // neither survives compression: "Windows Credential Manager" is the thing a
  // person can go and check, and the warning is useless without who is exposed.
  'Mesh saved another copy in Windows Credential Manager on this device, and someone who can use this Windows account may be able to ask Mesh to use it.',
])

const CODE_MARKERS = [
  '=>', 'const ', 'function', 'className', 'return ', 'useState', '${', '</', '/>',
  'import ', 'http', 'var(--', 'px-', '=== ', '&&', '||', '?.', 'aria-', 'data-',
]

/** Abbreviations whose period does not end a sentence. */
const ABBREVIATIONS = /\b(?:e\.g|i\.e|etc|vs|Mr|Ms|Dr|approx|no)\.$/i

export function countSentences(text) {
  const trimmed = text.trim()
  if (!trimmed) return 0
  // A decimal, a version, or a size ("1.5 MB") is not a sentence boundary.
  const withoutNumbers = trimmed.replace(/\d\.\d/g, '00')
  const parts = withoutNumbers
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !ABBREVIATIONS.test(part))
  // A trailing fragment with no terminator still reads as a sentence.
  return parts.length
}

export function proseStrings(source) {
  const found = []
  const pattern = /(['"])((?:[^'"\\\n]|\\.){24,})\1/g
  for (const match of source.matchAll(pattern)) {
    const text = match[2]
    if (CODE_MARKERS.some((marker) => text.includes(marker))) continue
    if (!/^[A-Z]/.test(text)) continue
    if (!/[a-z]\s[a-z]/.test(text)) continue
    if (text.split(' ').length < 6) continue
    found.push({ text, index: match.index ?? 0 })
  }
  return found
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      // The design preview is a fixture, not a surface somebody reads.
      return entry.name === 'dev' ? [] : sourceFiles(entryPath)
    }
    // Copy lives in `.ts` too: error messages, device failures, and known
    // limitations are written in lib modules and reach the screen unchanged.
    const isSource = entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')
    if (!isSource || entry.name.includes('.test.') || entry.name.endsWith('.d.ts')) return []
    return [entryPath]
  }))
  return files.flat()
}

export async function findDenseCopy() {
  const violations = []
  for (const file of await sourceFiles(sourceRoot)) {
    const source = await readFile(file, 'utf8')
    for (const { text, index } of proseStrings(source)) {
      if (ALLOWED_STRINGS.has(text)) continue
      const sentences = countSentences(text)
      const words = text.split(/\s+/).filter(Boolean).length
      const tooLong = words > MAXIMUM_WORDS
      const tooMany = sentences > MAXIMUM_SENTENCES
      if (!tooLong && !tooMany) continue
      violations.push({
        file: path.relative(root, file),
        line: source.slice(0, index).split('\n').length,
        words,
        sentences,
        reason: tooLong ? `${words} words` : `${sentences} sentences`,
        text,
      })
    }
  }
  return violations
}

// Kept here so weakening the detector cannot silently pass.
const selfTest = [
  ['One sentence about a thing that happens', 1],
  ['First sentence here. Second sentence here.', 2],
  ['Upload a picture up to 1.5 MB in size', 1],
  ['Formats are PNG, JPEG or WebP. Up to 1 MB.', 2],
]
for (const [sample, expected] of selfTest) {
  if (countSentences(sample) !== expected) {
    throw new Error(`Copy density self-test failed for "${sample}": expected ${expected}, got ${countSentences(sample)}`)
  }
}

async function main() {
  const violations = await findDenseCopy()
  if (violations.length > 0) {
    const shown = violations.slice(0, 25)
    throw new Error(
      `Copy density check failed: ${violations.length} user-facing string(s) run past `
      + `${MAXIMUM_WORDS} words or ${MAXIMUM_SENTENCES} sentences.\n`
      + shown.map((v) => `- ${v.file}:${v.line} (${v.reason})\n    ${v.text.slice(0, 110)}`).join('\n')
      + (violations.length > shown.length ? `\n  and ${violations.length - shown.length} more` : '')
      + '\n\n  Every sentence has to change what somebody does. If one genuinely does and'
      + '\n  still will not fit, add the exact string to ALLOWED_STRINGS and record the'
      + '\n  fact a reader would lose in ALLOWED_LONG_COPY.',
    )
  }
  console.log(
    `Copy density check passed: no user-facing string runs past ${MAXIMUM_WORDS} words `
    + `or ${MAXIMUM_SENTENCES} sentences (${ALLOWED_STRINGS.size} recorded exception(s)).`,
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
