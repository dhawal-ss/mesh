import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const [featureGraph, ...testFiles] = process.argv.slice(2)
if (!['matrix-voice', 'legacy-p2p'].includes(featureGraph) || testFiles.length === 0) {
  console.error('Usage: node scripts/run-feature-vitest.mjs <matrix-voice|legacy-p2p> <test-file>...')
  process.exit(2)
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vitest = path.join(projectRoot, 'node_modules', 'vitest', 'vitest.mjs')
const result = spawnSync(
  process.execPath,
  [vitest, 'run', '--configLoader', 'runner', ...testFiles],
  {
    cwd: projectRoot,
    env: { ...process.env, MESH_FEATURE_GRAPH: featureGraph },
    stdio: 'inherit',
  },
)
if (result.error) throw result.error
process.exit(result.status ?? 1)
