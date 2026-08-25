[CmdletBinding()]
param(
    [string]$BundleRoot,
    [string]$ExpectedVersion
)

$ErrorActionPreference = "Stop"
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))

function Assert-Condition {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) {
        throw $Message
    }
}

Assert-Condition ([Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
    [Runtime.InteropServices.OSPlatform]::Windows
)) "Compiled Windows installer inspection must run on Windows."

if ([string]::IsNullOrWhiteSpace($ExpectedVersion)) {
    $config = Get-Content -LiteralPath (Join-Path $repoRoot "src-tauri/tauri.conf.json") -Raw |
        ConvertFrom-Json
    $ExpectedVersion = [string]$config.version
}

if ([string]::IsNullOrWhiteSpace($BundleRoot)) {
    $BundleRoot = Join-Path $repoRoot "src-tauri/target/release/bundle"
}
$resolvedBundleRoot = [IO.Path]::GetFullPath($BundleRoot)
Assert-Condition (Test-Path -LiteralPath $resolvedBundleRoot -PathType Container) `
    "Installer bundle root does not exist: $resolvedBundleRoot"

$versionPattern = [regex]::Escape($ExpectedVersion)
$msiFiles = @(
    Get-ChildItem -LiteralPath $resolvedBundleRoot -Recurse -File -Filter "*.msi" |
        Where-Object { $_.Name -match $versionPattern }
)
$nsisFiles = @(
    Get-ChildItem -LiteralPath $resolvedBundleRoot -Recurse -File -Filter "*.exe" |
        Where-Object { $_.Name -match $versionPattern -and $_.Name -match "(?i)setup" }
)
Assert-Condition ($msiFiles.Count -eq 1) `
    "Expected exactly one MSI for $ExpectedVersion; found $($msiFiles.Count)."
Assert-Condition ($nsisFiles.Count -eq 1) `
    "Expected exactly one NSIS installer for $ExpectedVersion; found $($nsisFiles.Count)."

$dark = @(
    Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA "tauri") `
        -Recurse -File -Filter "dark.exe" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending
) | Select-Object -First 1
Assert-Condition ($null -ne $dark) `
    "WiX dark.exe was not found after MSI creation; compiled coexistence controls cannot be inspected."

$temporaryWxs = Join-Path ([IO.Path]::GetTempPath()) `
    ("mesh-installer-contract-{0}.wxs" -f [guid]::NewGuid().ToString("N"))
try {
    & $dark.FullName -nologo $msiFiles[0].FullName -o $temporaryWxs | Out-Null
    Assert-Condition ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $temporaryWxs -PathType Leaf)) `
        "The generated MSI could not be decompiled for coexistence inspection."
    $compiled = Get-Content -LiteralPath $temporaryWxs -Raw

    $requiredPatterns = [ordered]@{
        "compiled consumer-marker search" = 'Property Id="MESH_NSIS_INSTALL"[\s\S]*?RegistrySearch[^>]+Root="HKCU"[^>]+Key="Software\\Mesh\\Installer"[^>]+Name="Format"'
        "compiled blocking error action" = 'CustomAction Id="MeshBlockNsisCoexistence" Error="A consumer Mesh installation is already present\.'
        "compiled UI block sequence" = 'InstallUISequence[\s\S]*?Action="MeshBlockNsisCoexistence" After="AppSearch">MESH_NSIS_INSTALL = "nsis" AND NOT Installed'
        "compiled silent block sequence" = 'InstallExecuteSequence[\s\S]*?Action="MeshBlockNsisCoexistence" After="AppSearch">MESH_NSIS_INSTALL = "nsis" AND NOT Installed'
        "compiled managed-publisher isolation" = 'CustomAction Id="MeshSetManagedPublisher" Property="Manufacturer" Value="Mesh managed deployment"'
        "compiled managed marker" = 'Component Id="MeshMsiInstallerMarker"[\s\S]*?RegistryValue[^>]+Root="HKLM"[^>]+Key="Software\\Mesh\\Installer"[^>]+Name="Format"[^>]+Value="msi"'
        "linked managed marker feature" = 'ComponentRef Id="MeshMsiInstallerMarker"'
    }
    foreach ($entry in $requiredPatterns.GetEnumerator()) {
        Assert-Condition ($compiled -match $entry.Value) `
            "The MSI is missing $($entry.Key). The source fragment may not have been linked."
    }
} finally {
    if (Test-Path -LiteralPath $temporaryWxs -PathType Leaf) {
        Remove-Item -LiteralPath $temporaryWxs -Force
    }
}

Write-Host "Compiled installer coexistence controls passed for ${ExpectedVersion}: MSI UI/silent guards and both installer artifacts are present."
