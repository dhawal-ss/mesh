param(
    [string]$OutputDirectory = "",
    [string]$ToolCacheDirectory = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version Latest

$isWindows = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
    [System.Runtime.InteropServices.OSPlatform]::Windows
)
if (-not $isWindows) {
    throw "The local container prototype bootstrap currently supports Windows AMD64 only."
}
if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne `
    [System.Runtime.InteropServices.Architecture]::X64) {
    throw "The local container prototype bootstrap requires Windows AMD64."
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$policyPath = Join-Path $projectRoot "infra/container-prototypes/prototype-policy.json"
$policy = Get-Content -LiteralPath $policyPath -Raw | ConvertFrom-Json

Push-Location $projectRoot
try {
    & npm.cmd run check:container-supply-chain
    if ($LASTEXITCODE -ne 0) {
        throw "Container prototype policy validation failed before tool download."
    }
} finally {
    Pop-Location
}

if ([string]::IsNullOrWhiteSpace($ToolCacheDirectory)) {
    $ToolCacheDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "mesh-container-prototype-tools-v1"
}
$toolCacheRoot = [System.IO.Path]::GetFullPath($ToolCacheDirectory)
New-Item -ItemType Directory -Force -Path $toolCacheRoot | Out-Null

function Get-PinnedPrototypeTool {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Version,
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$ArchiveSha256,
        [Parameter(Mandatory = $true)][string]$ExecutableSha256
    )

    if ($Name -notin @("syft", "grype") -or $Version -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') {
        throw "Refusing an unsupported prototype tool identity."
    }
    if ($Url -notmatch '^https://github\.com/anchore/(syft|grype)/releases/download/') {
        throw "Refusing a prototype tool download outside the reviewed Anchore release origin."
    }
    if ($ArchiveSha256 -notmatch '^[0-9a-f]{64}$' -or $ExecutableSha256 -notmatch '^[0-9a-f]{64}$') {
        throw "Prototype tool hashes must be exact lowercase SHA-256 values."
    }

    $cacheKey = "$Name-$Version-windows-amd64"
    $toolRoot = Join-Path $toolCacheRoot $cacheKey
    $executablePath = Join-Path $toolRoot "$Name.exe"
    $archivePath = Join-Path $toolRoot "$Name.zip"
    New-Item -ItemType Directory -Force -Path $toolRoot | Out-Null

    if (Test-Path -LiteralPath $executablePath -PathType Leaf) {
        $cachedExecutableHash = (Get-FileHash -LiteralPath $executablePath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($cachedExecutableHash -eq $ExecutableSha256) {
            Write-Host "Using verified cached $Name $Version."
            return $executablePath
        }
    }

    $archiveReady = $false
    if (Test-Path -LiteralPath $archivePath -PathType Leaf) {
        $cachedArchiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
        $archiveReady = $cachedArchiveHash -eq $ArchiveSha256
    }
    if (-not $archiveReady) {
        $downloadPath = Join-Path $toolRoot ("download-" + [guid]::NewGuid().ToString("N") + ".zip")
        Write-Host "Downloading pinned $Name $Version from its official release asset..."
        Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $downloadPath
        $downloadHash = (Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($downloadHash -ne $ArchiveSha256) {
            throw "Downloaded $Name archive did not match the policy SHA-256."
        }
        Move-Item -LiteralPath $downloadPath -Destination $archivePath -Force
    }

    $extractRoot = Join-Path $toolRoot ("extract-" + [guid]::NewGuid().ToString("N"))
    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot
    $candidates = @(Get-ChildItem -LiteralPath $extractRoot -Recurse -File -Filter "$Name.exe")
    if ($candidates.Count -ne 1) {
        throw "The verified $Name archive did not contain exactly one $Name.exe."
    }
    $candidateHash = (Get-FileHash -LiteralPath $candidates[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($candidateHash -ne $ExecutableSha256) {
        throw "Extracted $Name executable did not match the policy SHA-256."
    }
    Copy-Item -LiteralPath $candidates[0].FullName -Destination $executablePath -Force
    return $executablePath
}

$syftPath = Get-PinnedPrototypeTool `
    -Name "syft" `
    -Version $policy.scannerPolicy.syftVersion `
    -Url $policy.scannerPolicy.syftWindowsAmd64Url `
    -ArchiveSha256 $policy.scannerPolicy.syftWindowsAmd64ArchiveSha256 `
    -ExecutableSha256 $policy.scannerPolicy.syftWindowsAmd64Sha256
$grypePath = Get-PinnedPrototypeTool `
    -Name "grype" `
    -Version $policy.scannerPolicy.grypeVersion `
    -Url $policy.scannerPolicy.grypeWindowsAmd64Url `
    -ArchiveSha256 $policy.scannerPolicy.grypeWindowsAmd64ArchiveSha256 `
    -ExecutableSha256 $policy.scannerPolicy.grypeWindowsAmd64Sha256

$buildScript = Join-Path $PSScriptRoot "build-local-container-prototypes.ps1"
$buildArguments = @{
    SyftPath = $syftPath
    GrypePath = $grypePath
}
if (-not [string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $buildArguments.OutputDirectory = $OutputDirectory
}
& $buildScript @buildArguments
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
