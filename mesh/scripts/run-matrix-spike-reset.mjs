import { spawnSync } from 'node:child_process'
import process from 'node:process'

export function powerShellCommand(platform = process.platform) {
  return platform === 'win32' ? 'powershell.exe' : 'pwsh'
}

const command = powerShellCommand()
const result = spawnSync(
  command,
  [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    './infra/matrix-spike/setup.ps1',
    '-Reset',
  ],
  {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: false,
  },
)

if (result.error) {
  console.error(`Could not start ${command}: ${result.error.message}`)
  process.exit(1)
}

process.exit(result.status ?? 1)
