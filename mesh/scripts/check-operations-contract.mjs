import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const read = (path) => readFile(new URL(path, root), 'utf8')
const [
  crashSource,
  appSource,
  observability,
  incidentResponse,
  trustAndSafety,
  syncDecision,
  supportPage,
  homeserverCompose,
  spikeCompose,
  homeserverSetup,
  admissionProvision,
  homeserverCaddy,
  homeserverRestore,
  homeserverRestoreTest,
  spikeSetup,
  releaseWorkflow,
  ciWorkflow,
  matrixAcceptanceWorkflow,
  securityPolicy,
  publicSecurityPage,
  disclosureDrill,
  secretRotation,
  admissionService,
  homeserverReadme,
  homeserverEnvExample,
] = await Promise.all([
  read('src-tauri/src/crash_report.rs'),
  read('src-tauri/src/lib.rs'),
  read('docs/operations/OBSERVABILITY.rst'),
  read('docs/operations/INCIDENT_RESPONSE.rst'),
  read('docs/operations/TRUST_AND_SAFETY.rst'),
  read('docs/architecture/sync-performance-decision.rst'),
  read('../site/support/index.html'),
  read('infra/homeserver/docker-compose.yml'),
  read('infra/matrix-spike/docker-compose.yml'),
  read('infra/homeserver/setup.sh'),
  read('infra/homeserver/provision-admission-database.sh'),
  read('infra/homeserver/Caddyfile'),
  read('infra/homeserver/restore-drill.sh'),
  read('infra/homeserver/tests/restore-drill.integration.sh'),
  read('infra/matrix-spike/setup.ps1'),
  read('../.github/workflows/release-beta.yml'),
  read('../.github/workflows/ci.yml'),
  read('../.github/workflows/matrix-federation-acceptance.yml'),
  read('../SECURITY.md'),
  read('../site/security/index.html'),
  read('scripts/security-disclosure-drill.mjs'),
  read('infra/homeserver/rotate-runtime-secrets.sh'),
  read('infra/homeserver/admission_service.py'),
  read('infra/homeserver/README.md'),
  read('infra/homeserver/.env.example'),
])

assert.match(appSource, /crash_report::install\(&app_data_dir/)
assert.match(crashSource, /const CRASH_MARKER_FILE: &str = "last-crash\.json"/)
assert.match(crashSource, /Path::new\(file\)[\s\S]*?\.file_name\(\)/)
assert.doesNotMatch(crashSource, /panic_info\.payload\(/)
assert.doesNotMatch(crashSource, /Backtrace/)

const compact = (value) => value.replace(/\s+/g, ' ')

for (const statement of [
  'never leaves the device automatically',
  'never uploads automatically',
  'Do not add a telemetry SDK',
]) {
  assert.equal(compact(observability).includes(statement), true, `observability contract is missing: ${statement}`)
}
for (const statement of [
  'must name an incident commander',
  'Do not rotate a Matrix server name or signing identity',
  'one independent restore exercise',
]) {
  assert.equal(compact(incidentResponse).includes(statement), true, `incident contract is missing: ${statement}`)
}
for (const statement of [
  'Mesh is a client, not a global moderator',
  'authoritative Matrix state',
  'Do not invent custom federated deletion',
]) {
  assert.equal(trustAndSafety.includes(statement), true, `trust and safety contract is missing: ${statement}`)
}
for (const statement of [
  'currently uses Matrix ``/sync``',
  '50, 500, and 5,000 rooms',
  'Do not expose the sync strategy as an onboarding decision',
]) {
  assert.equal(syncDecision.includes(statement), true, `sync decision is missing: ${statement}`)
}
for (const statement of [
  'Mesh cannot promise a universal appeal',
  'Mesh does not upload crash diagnostics automatically',
]) {
  assert.equal(supportPage.includes(statement), true, `public support routing is missing: ${statement}`)
}

const synapsePin = 'matrixdotorg/synapse:v1.157.1@sha256:d1fce43d7501428c461f2758dc10342555b946dc9f1d03c1b1b8aec1a4e8d130'
for (const [name, compose] of [
  ['homeserver', homeserverCompose],
  ['matrix spike', spikeCompose],
]) {
  assert.equal(compose.includes(synapsePin), true, `${name} does not use the reviewed Synapse image digest`)
  assert.doesNotMatch(compose, /matrixdotorg\/synapse:(?:latest|v1\.157\.0)/)
}
for (const [name, source] of [
  ['homeserver setup', homeserverSetup],
  ['homeserver restore drill', homeserverRestore],
  ['homeserver restore test', homeserverRestoreTest],
  ['matrix spike setup', spikeSetup],
]) {
  assert.equal(source.includes(synapsePin), true, `${name} does not use the reviewed Synapse image digest`)
  assert.doesNotMatch(source, /matrixdotorg\/synapse:(?:latest|v1\.157\.0)/)
}

assert.match(ciWorkflow, /npm run check:operations-contract/)
assert.match(releaseWorkflow, /npm run check:operations-contract/)

const admissionBlock = homeserverCompose.match(/\n  admission:\n[\s\S]*?\n  caddy:\n/)?.[0] ?? ''
assert.doesNotMatch(admissionBlock, /env_file:/)
assert.doesNotMatch(admissionBlock, /REGISTRATION_SHARED_SECRET|MACAROON_SECRET_KEY|FORM_SECRET/)
assert.match(admissionBlock, /POSTGRES_PASSWORD: "\$\{MESH_ADMISSION_DB_PASSWORD:/)
assert.match(admissionBlock, /read_only: true/)
assert.match(admissionBlock, /cap_drop:\s+- ALL/)
assert.match(admissionBlock, /pids_limit: 64/)
assert.match(admissionBlock, /- admission-db[\s\S]*- admission-control/)
assert.match(admissionProvision, /CREATE ROLE mesh_admission_owner NOLOGIN/)
assert.match(admissionProvision, /signing_key_id TEXT NOT NULL/)
assert.match(admissionProvision, /GRANT SELECT, INSERT, UPDATE, DELETE[\s\S]*mesh_admission_invitations[\s\S]*mesh_admission_openid_proofs/)
assert.match(admissionProvision, /SELECT 1 FROM public\.users LIMIT 0/)
assert.doesNotMatch(homeserverCaddy, /reverse_proxy admission/)

assert.match(spikeSetup, /Remove-MatrixSpikeRuntimeDirectory/)
assert.match(spikeSetup, /find \/mesh-cleanup -mindepth 1 -maxdepth 1 -exec rm -rf/)
assert.match(spikeSetup, /StartsWith\(\$runtimePrefix/)

assert.match(matrixAcceptanceWorkflow, /for cycle in 1 2; do/)
assert.match(matrixAcceptanceWorkflow, /setup:matrix-spike:reset/)
assert.match(matrixAcceptanceWorkflow, /test:matrix-spike/)
assert.match(matrixAcceptanceWorkflow, /teardown-cycle-\$cycle\.log/)
assert.match(matrixAcceptanceWorkflow, /sourceTreeHash/)
assert.match(matrixAcceptanceWorkflow, /workflowRunId/)
assert.match(matrixAcceptanceWorkflow, /retention-days: 30/)
assert.match(matrixAcceptanceWorkflow, /Upload acceptance logs[\s\S]*?if: \$\{\{ always\(\) \}\}/)

assert.match(securityPolicy, /\*\*Confidential route status: unavailable\.\*\*/)
assert.match(publicSecurityPage, /Confidential reporting is not available yet/)
assert.match(publicSecurityPage, /private vulnerability reporting is currently disabled/)
assert.doesNotMatch(publicSecurityPage, /github\.com\/dhawal-ss\/mesh\/security\/advisories\/new/)
assert.match(disclosureDrill, /private-vulnerability-reporting/)
assert.match(disclosureDrill, /--online/)

for (const phase of ['--stage', '--activate', '--rollback', '--revoke-previous']) {
  assert.equal(secretRotation.includes(phase), true, `secret rotation is missing ${phase}`)
}
assert.match(secretRotation, /MESH_SECRET_ROTATION_CONFIRM/)
assert.match(secretRotation, /rollback_on_error/)
assert.match(secretRotation, /active_previous_invites/)
assert.match(secretRotation, /rotation-evidence/)
assert.match(secretRotation, /MESH_ADMISSION_PREVIOUS_SIGNING_KEYS/)
assert.match(homeserverEnvExample, /^MESH_ADMISSION_SIGNING_KEY_ID=.+$/m)
assert.match(homeserverEnvExample, /^MESH_ADMISSION_PREVIOUS_SIGNING_KEYS=/m)
assert.match(homeserverSetup, /REPLACE_\*\)[\s\S]*MESH_ADMISSION_SIGNING_KEY_ID=/)
assert.match(admissionService, /invitation_signing_key/)
assert.match(admissionService, /invitation_key_retired/)
assert.match(homeserverReadme, /previous admission signing key during the overlap window/)

console.log('Operations contract passed: disclosure, two-cycle evidence, safe cleanup, staged rotation, pinned Synapse, and isolated admission runtime.')
