import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const maxBytes = 350 * 1024
const assetsDirectory = new URL('../dist/assets/', import.meta.url)
const entries = await readdir(assetsDirectory)
const entryChunks = entries.filter((name) => /^index-[^/]+\.js$/.test(name))

if (entryChunks.length !== 1) {
  throw new Error(`Expected exactly one frontend entry chunk, found ${entryChunks.length}.`)
}

const entryName = entryChunks[0]
const entrySize = (await stat(join(fileURLToPath(assetsDirectory), entryName))).size
if (entrySize > maxBytes) {
  throw new Error(
    `Frontend entry chunk ${entryName} is ${(entrySize / 1024).toFixed(2)} KiB; maximum is 350 KiB.`,
  )
}

console.log(`Frontend entry chunk budget passed: ${entryName} is ${(entrySize / 1024).toFixed(2)} KiB.`)
