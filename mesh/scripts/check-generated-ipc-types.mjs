import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const generatedPath = join(repoRoot, 'src', 'types', 'ipc.generated.ts')
const before = readFileSync(generatedPath, 'utf8')
const cargo = process.platform === 'win32' ? 'cargo.exe' : 'cargo'

const result = spawnSync(
  cargo,
  [
    'run',
    '--manifest-path',
    join(repoRoot, 'src-tauri', 'Cargo.toml'),
    '--bin',
    'export_ipc_types',
    '--no-default-features',
    '--features',
    'matrix-backend',
    '--locked',
  ],
  { cwd: repoRoot, encoding: 'utf8' },
)

if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
if (result.status !== 0) process.exit(result.status ?? 1)

const after = readFileSync(generatedPath, 'utf8')
if (after !== before) {
  console.error(
    'src/types/ipc.generated.ts was stale and has been regenerated. Review and check in the updated file.',
  )
  process.exit(1)
}

console.log('Generated Rust-to-TypeScript IPC DTO contract is current.')
