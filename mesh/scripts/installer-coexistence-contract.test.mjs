import assert from 'node:assert/strict'
import test from 'node:test'
import {
  loadInstallerCoexistenceContract,
  validateInstallerCoexistence,
} from './installer-coexistence-contract.mjs'

const clone = (value) => structuredClone(value)

test('tracked NSIS and MSI coexistence controls are complete', async () => {
  assert.deepEqual(
    validateInstallerCoexistence(await loadInstallerCoexistenceContract()),
    [],
  )
})

test('rejects an unlinked WiX guard fragment', async () => {
  const contract = clone(await loadInstallerCoexistenceContract())
  contract.config.bundle.windows.wix.componentRefs = []
  assert.ok(
    validateInstallerCoexistence(contract).some((error) => error.includes('link the coexistence')),
  )
})

test('rejects an NSIS guard that checks the wrong registry authority', async () => {
  const contract = clone(await loadInstallerCoexistenceContract())
  contract.nsisHooks = contract.nsisHooks.replace('ReadRegStr $R9 HKLM', 'ReadRegStr $R9 HKCU')
  assert.ok(
    validateInstallerCoexistence(contract).some((error) => error.includes('managed marker read')),
  )
})

test('rejects an NSIS guard that does not terminate before file copy', async () => {
  const contract = clone(await loadInstallerCoexistenceContract())
  contract.nsisHooks = contract.nsisHooks.replace('    Quit\n', '')
  assert.ok(
    validateInstallerCoexistence(contract).some((error) => error.includes('pre-copy termination')),
  )
})

test('rejects an MSI guard missing silent execution enforcement', async () => {
  const contract = clone(await loadInstallerCoexistenceContract())
  contract.wixFragment = contract.wixFragment.replace(
    /    <InstallExecuteSequence>[\s\S]*?    <\/InstallExecuteSequence>\n/,
    '',
  )
  assert.ok(
    validateInstallerCoexistence(contract).some((error) => error.includes('silent-sequence')),
  )
})

test('rejects a managed marker written to the current-user hive', async () => {
  const contract = clone(await loadInstallerCoexistenceContract())
  contract.wixFragment = contract.wixFragment.replace(
    'RegistryKey Root="HKLM" Key="Software\\Mesh\\Installer"',
    'RegistryKey Root="HKCU" Key="Software\\Mesh\\Installer"',
  )
  assert.ok(
    validateInstallerCoexistence(contract).some((error) => error.includes('managed marker component')),
  )
})

test('rejects removal of the Tauri automatic MSI migration isolation', async () => {
  const contract = clone(await loadInstallerCoexistenceContract())
  contract.wixFragment = contract.wixFragment.replace('Mesh managed deployment', 'mesh')
  assert.ok(
    validateInstallerCoexistence(contract).some((error) => error.includes('migration isolation')),
  )
})
