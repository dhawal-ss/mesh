import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const banner = [
  '============================================================',
  'UNSIGNED LOCAL BUILD - NOT A RELEASE CANDIDATE',
  'This command builds the text-only Matrix developer preview.',
  'The public-beta candidate must use the signed Matrix voice factory.',
  '============================================================',
].join('\n')

console.error(banner)

const child = spawn(
  process.execPath,
  [
    resolve('node_modules/@tauri-apps/cli/tauri.js'),
    'build',
    '--features',
    'matrix-backend',
    '--',
    '--no-default-features',
    '--locked',
    '--jobs',
    '1',
  ],
  {
    cwd: process.cwd(),
    stdio: 'inherit',
  },
)

child.on('error', (error) => {
  console.error(`Could not start the unsigned Matrix build: ${error.message}`)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Unsigned Matrix build stopped after signal ${signal}`)
    process.exit(1)
  }
  process.exit(code ?? 1)
})
