import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const action = process.argv[2]
if (action !== 'build' && action !== 'dev') {
  console.error('Usage: node scripts/run-matrix-voice-tauri.mjs <build|dev>')
  process.exit(2)
}

const executable = process.execPath
const args = [
  resolve('node_modules/@tauri-apps/cli/tauri.js'),
  action,
  '--config',
  'src-tauri/tauri.matrix-voice.conf.json',
  '--features',
  'matrix-voice',
]
if (action === 'build') {
  args.push('--', '--no-default-features', '--locked', '--jobs', '1')
}

const child = spawn(executable, args, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    MESH_MATRIX_VOICE_FRONTEND: 'matrix-voice',
  },
  stdio: 'inherit',
})

child.on('error', (error) => {
  console.error(`Could not start the Matrix voice ${action}: ${error.message}`)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Matrix voice ${action} stopped after signal ${signal}`)
    process.exit(1)
  }
  process.exit(code ?? 1)
})
