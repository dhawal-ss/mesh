[CmdletBinding()]
param(
    [string]$CargoRoot = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($CargoRoot)) {
    $CargoRoot = Join-Path (Split-Path -Parent $PSScriptRoot) "src-tauri"
} elseif (-not [IO.Path]::IsPathRooted($CargoRoot)) {
    $CargoRoot = Join-Path (Split-Path -Parent $PSScriptRoot) $CargoRoot
}
$CargoRoot = (Resolve-Path -LiteralPath $CargoRoot).Path
$manifestPath = Join-Path $CargoRoot "Cargo.toml"
$lockPath = Join-Path $CargoRoot "Cargo.lock"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
    throw "CargoRoot must contain the Mesh Cargo.toml and Cargo.lock."
}

function Invoke-FeatureTree([string]$Feature) {
    $tree = & cargo tree `
        --manifest-path $manifestPath `
        --no-default-features `
        --features $Feature `
        --locked `
        -e normal,build 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "cargo tree failed for feature '$Feature'."
    }
    return [string]::Join("`n", @($tree))
}

$matrixTree = Invoke-FeatureTree "matrix-backend"
$legacyTree = Invoke-FeatureTree "legacy-p2p"
$forbiddenMatrixPackages = [ordered]@{
    "libp2p" = "(?m)(^|[ (])libp2p v"
    "hickory-proto 0.24.4" = "(?m)(^|[ (])hickory-proto v0\.24\.4(?:\s|$)"
    "ring 0.16.20" = "(?m)(^|[ (])ring v0\.16\.20(?:\s|$)"
    "rustls-webpki 0.101.7" = "(?m)(^|[ (])rustls-webpki v0\.101\.7(?:\s|$)"
}

foreach ($entry in $forbiddenMatrixPackages.GetEnumerator()) {
    if ($matrixTree -match $entry.Value) {
        throw "Matrix release dependency tree contains forbidden legacy package: $($entry.Key)."
    }
}

$legacyFindings = @(
    $forbiddenMatrixPackages.GetEnumerator() |
        Where-Object { $legacyTree -match $_.Value } |
        ForEach-Object { $_.Key }
)

Write-Host "Matrix release dependency boundary passed."
Write-Host "Matrix graph excludes libp2p and the listed vulnerable legacy versions."
if ($legacyFindings.Count -gt 0) {
    Write-Host (
        "Legacy graph remains separately affected by: " +
        ($legacyFindings -join ", ") +
        ". These findings are not reported as fixed."
    ) -ForegroundColor Yellow
} else {
    Write-Host "Legacy graph no longer contains the previously enumerated packages."
}
