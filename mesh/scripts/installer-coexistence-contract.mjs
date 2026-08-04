import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const root = new URL('../', import.meta.url)

export async function loadInstallerCoexistenceContract() {
  const [config, nsisHooks, wixFragment] = await Promise.all([
    readFile(new URL('src-tauri/tauri.conf.json', root), 'utf8').then(JSON.parse),
    readFile(new URL('src-tauri/windows/installer-coexistence.nsh', root), 'utf8'),
    readFile(new URL('src-tauri/windows/installer-coexistence.wxs', root), 'utf8'),
  ])
  return { config, nsisHooks, wixFragment }
}

export function validateInstallerCoexistence({ config, nsisHooks, wixFragment }) {
  const errors = []
  const windows = config?.bundle?.windows
  const nsis = windows?.nsis
  const wix = windows?.wix

  if (nsis?.installMode !== 'currentUser') {
    errors.push('NSIS must remain a current-user installer')
  }
  if (nsis?.installerHooks !== 'windows/installer-coexistence.nsh') {
    errors.push('NSIS must load the reviewed coexistence hooks')
  }
  if (!wix?.fragmentPaths?.includes('windows/installer-coexistence.wxs')) {
    errors.push('MSI must compile the reviewed coexistence fragment')
  }
  if (!wix?.componentRefs?.includes('MeshMsiInstallerMarker')) {
    errors.push('MSI must link the coexistence fragment through its marker component')
  }

  for (const [label, pattern] of [
    ['stable marker key', /!define MESH_INSTALLER_MARKER_KEY "Software\\Mesh\\Installer"/],
    ['64-bit registry view', /SetRegView 64/],
    ['managed marker read', /ReadRegStr \$R9 HKLM "\$\{MESH_INSTALLER_MARKER_KEY\}" "Format"/],
    ['managed marker match', /\$R9 == "msi"/],
    ['non-zero coexistence exit', /SetErrorLevel 1638/],
    ['pre-copy termination', /!macro NSIS_HOOK_PREINSTALL[\s\S]*?Quit[\s\S]*?!macroend/],
    ['consumer marker write', /WriteRegStr HKCU "\$\{MESH_INSTALLER_MARKER_KEY\}" "Format" "nsis"/],
    ['format-owned cleanup', /!macro NSIS_HOOK_POSTUNINSTALL[\s\S]*?\$R9 == "nsis"[\s\S]*?DeleteRegValue HKCU/],
    ['plain retention guidance', /Remove Mesh from Windows Settings[\s\S]*?account data will be kept/],
  ]) {
    if (!pattern.test(nsisHooks)) errors.push(`NSIS is missing ${label}`)
  }

  for (const [label, pattern] of [
    ['consumer marker search', /RegistrySearch[\s\S]*?Root="HKCU"[\s\S]*?Key="Software\\Mesh\\Installer"[\s\S]*?Name="Format"/],
    ['blocking error action', /CustomAction[\s\S]*?Id="MeshBlockNsisCoexistence"[\s\S]*?Error="A consumer Mesh installation is already present\./],
    ['UI-sequence enforcement', /InstallUISequence[\s\S]*?Action="MeshBlockNsisCoexistence" After="AppSearch"[\s\S]*?MESH_NSIS_INSTALL = "nsis" AND NOT Installed[\s\S]*?<\/InstallUISequence>/],
    ['silent-sequence enforcement', /InstallExecuteSequence[\s\S]*?Action="MeshBlockNsisCoexistence" After="AppSearch"[\s\S]*?MESH_NSIS_INSTALL = "nsis" AND NOT Installed[\s\S]*?<\/InstallExecuteSequence>/],
    ['Tauri migration isolation', /Id="MeshSetManagedPublisher"[\s\S]*?Property="Manufacturer"[\s\S]*?Value="Mesh managed deployment"/],
    ['pre-registration publisher change', /Action="MeshSetManagedPublisher" Before="InstallInitialize"[\s\S]*?NOT Installed/],
    ['managed marker component', /Component Id="MeshMsiInstallerMarker"[\s\S]*?RegistryKey Root="HKLM" Key="Software\\Mesh\\Installer"[\s\S]*?Name="Format" Type="string" Value="msi"/],
    ['plain retention guidance', /Remove Mesh from Windows Settings[\s\S]*?account data will be kept/],
  ]) {
    if (!pattern.test(wixFragment)) errors.push(`MSI is missing ${label}`)
  }

  return errors
}

async function main() {
  const errors = validateInstallerCoexistence(await loadInstallerCoexistenceContract())
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`)
    process.exitCode = 1
    return
  }
  console.log('Installer coexistence contract passed: NSIS and MSI block cross-format installation before copying app files and retain account data.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
