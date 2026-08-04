!define MESH_INSTALLER_MARKER_KEY "Software\Mesh\Installer"
!define MESH_INSTALLER_GUIDANCE "A managed Mesh installation is already present. Remove Mesh from Windows Settings, then run this consumer installer again. Your Mesh account data will be kept."

!macro MESH_SET_INSTALLER_REGISTRY_VIEW
  !if "${ARCH}" == "x64"
    SetRegView 64
  !else if "${ARCH}" == "arm64"
    SetRegView 64
  !else
    SetRegView 32
  !endif
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro MESH_SET_INSTALLER_REGISTRY_VIEW
  ReadRegStr $R9 HKLM "${MESH_INSTALLER_MARKER_KEY}" "Format"
  ${If} $R9 == "msi"
    SetErrorLevel 1638
    ${IfNot} ${Silent}
      MessageBox MB_ICONSTOP|MB_OK "${MESH_INSTALLER_GUIDANCE}"
    ${EndIf}
    Quit
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro MESH_SET_INSTALLER_REGISTRY_VIEW
  WriteRegStr HKCU "${MESH_INSTALLER_MARKER_KEY}" "Format" "nsis"
  WriteRegStr HKCU "${MESH_INSTALLER_MARKER_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${MESH_INSTALLER_MARKER_KEY}" "MarkerVersion" "1"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro MESH_SET_INSTALLER_REGISTRY_VIEW
  ReadRegStr $R9 HKCU "${MESH_INSTALLER_MARKER_KEY}" "Format"
  ${If} $R9 == "nsis"
    DeleteRegValue HKCU "${MESH_INSTALLER_MARKER_KEY}" "Format"
    DeleteRegValue HKCU "${MESH_INSTALLER_MARKER_KEY}" "InstallLocation"
    DeleteRegValue HKCU "${MESH_INSTALLER_MARKER_KEY}" "MarkerVersion"
    DeleteRegKey /ifempty HKCU "${MESH_INSTALLER_MARKER_KEY}"
    DeleteRegKey /ifempty HKCU "Software\Mesh"
  ${EndIf}
!macroend
