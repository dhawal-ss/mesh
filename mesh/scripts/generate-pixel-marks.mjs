import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * Generates the identity mark vocabulary.
 *
 * Mesh's marks are masks: the visible pixel is `currentColor`, so a mask needs
 * only an alpha channel. One shared mask tinted from a five-colour palette meant
 * two communities collided as soon as there were six of them, and in the
 * high-contrast theme, where every avatar token flattens to white, every
 * identity in the rail rendered as the same silhouette. Form is the one channel
 * that survives a monochrome theme, so identity is carried by shape first and
 * colour second.
 *
 * Each glyph is drawn on an 8x8 grid and scaled by whole pixels, which is what
 * keeps the edges hard. Deliberately hand-drawn rather than generated from a
 * hash: a random silhouette reads as noise, and these have to look like marks
 * somebody chose.
 */

const GRID = 8
const SCALE = 12
const SIZE = GRID * SCALE

const MARKS = {
  diamond: [
    '...XX...',
    '..XXXX..',
    '.XXXXXX.',
    'XXXXXXXX',
    'XXXXXXXX',
    '.XXXXXX.',
    '..XXXX..',
    '...XX...',
  ],
  cross: [
    '..XXXX..',
    '..XXXX..',
    '..XXXX..',
    'XXXXXXXX',
    'XXXXXXXX',
    '..XXXX..',
    '..XXXX..',
    '..XXXX..',
  ],
  lattice: [
    '.X....X.',
    'XXX..XXX',
    '.XX..XX.',
    '...XX...',
    '...XX...',
    '.XX..XX.',
    'XXX..XXX',
    '.X....X.',
  ],
  heart: [
    '.XX..XX.',
    'XXXXXXXX',
    'XXXXXXXX',
    'XXXXXXXX',
    '.XXXXXX.',
    '..XXXX..',
    '...XX...',
    '........',
  ],
  burst: [
    '...XX...',
    '...XX...',
    'X..XX..X',
    '.XXXXXX.',
    '.XXXXXX.',
    'X..XX..X',
    '...XX...',
    '...XX...',
  ],
  ring: [
    '..XXXX..',
    '.X....X.',
    'X......X',
    'X......X',
    'X......X',
    'X......X',
    '.X....X.',
    '..XXXX..',
  ],
  chevron: [
    '...XX...',
    '..XXXX..',
    '.XX..XX.',
    'XX....XX',
    '...XX...',
    '..XXXX..',
    '.XX..XX.',
    'XX....XX',
  ],
  bars: [
    'XX.XX.XX',
    'XX.XX.XX',
    'XX.XX.XX',
    'XX.XX.XX',
    'XX.XX.XX',
    'XX.XX.XX',
    'XX.XX.XX',
    'XX.XX.XX',
  ],
  checker: [
    'XX..XX..',
    'XX..XX..',
    '..XX..XX',
    '..XX..XX',
    'XX..XX..',
    'XX..XX..',
    '..XX..XX',
    '..XX..XX',
  ],
  lens: [
    '........',
    '..XXXX..',
    '.XXXXXX.',
    'XX.XX.XX',
    'XX.XX.XX',
    '.XXXXXX.',
    '..XXXX..',
    '........',
  ],
  wave: [
    '........',
    'XX....XX',
    'XXX..XXX',
    '.XXXXXX.',
    '.XXXXXX.',
    'XXX..XXX',
    'XX....XX',
    '........',
  ],
  corners: [
    'XXX..XXX',
    'XXX..XXX',
    'XX....XX',
    '........',
    '........',
    'XX....XX',
    'XXX..XXX',
    'XXX..XXX',
  ],
  ladder: [
    'XX....XX',
    'XXXXXXXX',
    'XX....XX',
    'XXXXXXXX',
    'XX....XX',
    'XXXXXXXX',
    'XX....XX',
    'XXXXXXXX',
  ],
  blocks: [
    'XXX..XXX',
    'XXX..XXX',
    'XXX..XXX',
    '........',
    '........',
    'XXX..XXX',
    'XXX..XXX',
    'XXX..XXX',
  ],
  frame: [
    'XXXXXXXX',
    'X......X',
    'X.XXXX.X',
    'X.X..X.X',
    'X.X..X.X',
    'X.XXXX.X',
    'X......X',
    'XXXXXXXX',
  ],
  spark: [
    'X..XX..X',
    '.X.XX.X.',
    '..XXXX..',
    'XXXXXXXX',
    'XXXXXXXX',
    '..XXXX..',
    '.X.XX.X.',
    'X..XX..X',
  ],
  notch: [
    'XXXXXXXX',
    'XXXXXXXX',
    'XX....XX',
    'XX....XX',
    'XX....XX',
    'XX....XX',
    'XXXXXXXX',
    'XXXXXXXX',
  ],
  pin: [
    '...XX...',
    '..XXXX..',
    '.XXXXXX.',
    '..XXXX..',
    '...XX...',
    '...XX...',
    '..XXXX..',
    '.X.XX.X.',
  ],
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** Grayscale + alpha, 8 bit. Only alpha is read by a CSS mask. */
function encodePng(rows) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(SIZE, 0)
  header.writeUInt32BE(SIZE, 4)
  header[8] = 8
  header[9] = 4
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 2))
  let offset = 0
  for (let y = 0; y < SIZE; y += 1) {
    raw[offset] = 0
    offset += 1
    const row = rows[Math.floor(y / SCALE)]
    for (let x = 0; x < SIZE; x += 1) {
      const on = row[Math.floor(x / SCALE)] === 'X'
      raw[offset] = 255
      raw[offset + 1] = on ? 255 : 0
      offset += 2
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const outputDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'assets',
  'pixel',
  'marks',
)
mkdirSync(outputDirectory, { recursive: true })

let total = 0
for (const [name, rows] of Object.entries(MARKS)) {
  if (rows.length !== GRID || rows.some((row) => row.length !== GRID)) {
    throw new Error(`${name} is not ${GRID}x${GRID}`)
  }
  const png = encodePng(rows)
  writeFileSync(join(outputDirectory, `${name}.png`), png)
  total += png.length
}

console.log(
  `Wrote ${Object.keys(MARKS).length} identity marks to src/assets/pixel/marks (${total} bytes total).`,
)
