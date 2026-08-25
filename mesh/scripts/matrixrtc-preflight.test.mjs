import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const preflight = path.join(projectRoot, 'scripts', 'matrixrtc-preflight.ps1')

function findPowerShell() {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    const executable = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    assert.equal(existsSync(executable), true, `PowerShell is missing: ${executable}`)
    return executable
  }

  const located = spawnSync('sh', ['-c', 'command -v pwsh'], { encoding: 'utf8' })
  assert.equal(located.status, 0, located.stderr)
  const executable = located.stdout.trim()
  assert.notEqual(executable, '', 'pwsh could not be located')
  return executable
}

test('required MatrixRTC Compose rendering fails closed when Docker is unavailable', { timeout: 30_000 }, () => {
  const result = spawnSync(findPowerShell(), [
    '-NoProfile',
    '-File',
    preflight,
    '-RequireCompose',
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: path.join(tmpdir(), 'mesh-matrixrtc-no-external-tools'),
    },
    timeout: 25_000,
  })

  assert.notEqual(result.status, 0, 'preflight unexpectedly passed without Docker')
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /Compose rendering cannot be skipped/,
  )
})
