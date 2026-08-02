[CmdletBinding()]
param(
    [string]$CargoRoot = "",
    [string]$ReportPath = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$policyPath = Join-Path $PSScriptRoot "rust-dependency-policy.json"
if ([string]::IsNullOrWhiteSpace($CargoRoot)) {
    $CargoRoot = Join-Path $repoRoot "src-tauri"
} elseif (-not [IO.Path]::IsPathRooted($CargoRoot)) {
    $CargoRoot = Join-Path $repoRoot $CargoRoot
}
$CargoRoot = (Resolve-Path -LiteralPath $CargoRoot).Path
$manifestPath = Join-Path $CargoRoot "Cargo.toml"
$lockPath = Join-Path $CargoRoot "Cargo.lock"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
    throw "CargoRoot must contain the Mesh Cargo.toml and Cargo.lock."
}
if (-not (Test-Path -LiteralPath $policyPath -PathType Leaf)) {
    throw "Rust dependency policy is missing: $policyPath"
}

$policy = Get-Content -LiteralPath $policyPath -Raw | ConvertFrom-Json
if ($policy.schemaVersion -ne 1) {
    throw "Unsupported Rust dependency policy schema version."
}

function Invoke-CargoText {
    param([string[]]$Arguments, [string]$Description)

    $output = @(& cargo @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed."
    }
    return [string]::Join("`n", $output)
}

function Invoke-FeatureTree {
    param([string]$Feature, [string]$Target, [string]$Edges = "normal,build")

    $arguments = @(
        "tree",
        "--manifest-path", $manifestPath,
        "--no-default-features",
        "--features", $Feature,
        "--locked",
        "-e", $Edges
    )
    if (-not [string]::IsNullOrWhiteSpace($Target)) {
        $arguments += @("--target", $Target)
    }
    return Invoke-CargoText $arguments "cargo tree for feature '$Feature'"
}

function Get-PackagePattern {
    param([string]$Name, [string]$Version)

    $escapedName = [regex]::Escape($Name)
    $escapedVersion = [regex]::Escape($Version)
    return "(?m)(^|[^A-Za-z0-9_-])$escapedName v$escapedVersion(?:\s|$)"
}

$shippingFeature = [string]$policy.shipping.feature
$shippingTarget = [string]$policy.shipping.target
$matrixTree = Invoke-FeatureTree $shippingFeature $shippingTarget
$matrixRuntimeTree = Invoke-FeatureTree $shippingFeature $shippingTarget "normal"
$legacyTree = Invoke-FeatureTree ([string]$policy.engineeringVisibility.feature) ""

if ($matrixTree -match '(?m)(^|[ (])libp2p v') {
    throw "Matrix release dependency tree unexpectedly contains libp2p."
}

$expectedVulnerabilities = @($policy.nonShippingVulnerabilities)
foreach ($finding in $expectedVulnerabilities) {
    $pattern = Get-PackagePattern ([string]$finding.package) ([string]$finding.version)
    if ($matrixTree -match $pattern) {
        throw "Matrix release dependency tree contains excluded advisory package $($finding.package) $($finding.version)."
    }
    if ($legacyTree -notmatch $pattern) {
        throw "Legacy visibility policy is stale: $($finding.package) $($finding.version) is no longer present."
    }
}

$lockText = Get-Content -LiteralPath $lockPath -Raw
foreach ($minimum in @($policy.minimumVersions)) {
    $name = [regex]::Escape([string]$minimum.package)
    $match = [regex]::Match(
        $lockText,
        "(?ms)^\[\[package\]\]\r?\nname = `"$name`"\r?\nversion = `"(?<version>[^`"]+)`""
    )
    if (-not $match.Success) {
        throw "Required policy package is missing from Cargo.lock: $($minimum.package)."
    }
    if ([version]$match.Groups["version"].Value -lt [version]$minimum.version) {
        throw "$($minimum.package) must be at least $($minimum.version); found $($match.Groups['version'].Value)."
    }
}

$auditOutput = @(& cargo audit --file $lockPath --json 2>$null)
$auditExitCode = $LASTEXITCODE
try {
    $audit = [string]::Join("`n", $auditOutput) | ConvertFrom-Json
} catch {
    throw "cargo audit did not return valid JSON. Install the pinned cargo-audit version before running this policy."
}

$actualVulnerabilities = @($audit.vulnerabilities.list)
$expectedKeys = @(
    $expectedVulnerabilities |
        ForEach-Object { "$($_.id)|$($_.package)|$($_.version)" } |
        Sort-Object
)
$actualKeys = @(
    $actualVulnerabilities |
        ForEach-Object { "$($_.advisory.id)|$($_.package.name)|$($_.package.version)" } |
        Sort-Object
)
if (($expectedKeys -join "`n") -ne ($actualKeys -join "`n")) {
    throw "Raw cargo-audit vulnerability results differ from rust-dependency-policy.json. Review upstream fixes and update the policy without adding ignores. Expected [$($expectedKeys -join ', ')]; found [$($actualKeys -join ', ')]."
}
if ($expectedVulnerabilities.Count -eq 0 -and $auditExitCode -ne 0) {
    throw "cargo audit failed even though policy expects zero vulnerabilities."
}
if ($expectedVulnerabilities.Count -gt 0 -and $auditExitCode -eq 0) {
    throw "cargo audit unexpectedly passed while the policy still lists non-shipping vulnerabilities."
}

$warningCounts = [ordered]@{}
$expectedRawWarningCounts = $policy.expectedRawWarningCounts
$expectedShippingWarningKeys = @(
    @($policy.shippingRuntimeWarnings) |
        ForEach-Object { "$($_.kind)|$($_.id)|$($_.package)|$($_.version)" } |
        Sort-Object
)
$actualShippingWarningKeys = @()
$expectedBuildWarningKeys = @(
    @($policy.nonRuntimeBuildWarnings) |
        ForEach-Object { "$($_.id)|$($_.package)|$($_.version)" } |
        Sort-Object
)
$actualBuildWarningKeys = @()
foreach ($warningProperty in $audit.warnings.PSObject.Properties) {
    $warnings = @($warningProperty.Value)
    $warningCounts[$warningProperty.Name] = $warnings.Count
    foreach ($warning in $warnings) {
        $pattern = Get-PackagePattern ([string]$warning.package.name) ([string]$warning.package.version)
        $warningId = "no-advisory-id"
        if (($warning.PSObject.Properties.Name -contains "advisory") -and
            $null -ne $warning.advisory -and
            ($warning.advisory.PSObject.Properties.Name -contains "id")) {
            $warningId = [string]$warning.advisory.id
        }
        $warningKey = "$warningId|$($warning.package.name)|$($warning.package.version)"
        if ($matrixRuntimeTree -match $pattern) {
            $actualShippingWarningKeys += "$($warningProperty.Name)|$warningKey"
            if (@($policy.denyWarningKindsInShipping) -contains $warningProperty.Name) {
                throw "Matrix shipping runtime contains denied $($warningProperty.Name) warning: $warningKey."
            }
        } elseif (($matrixTree -match $pattern) -and
            (@($policy.denyWarningKindsInShipping) -contains $warningProperty.Name)) {
            $actualBuildWarningKeys += $warningKey
        }
    }
}
$actualShippingWarningKeys = @($actualShippingWarningKeys | Sort-Object -Unique)
if (($expectedShippingWarningKeys -join "`n") -ne ($actualShippingWarningKeys -join "`n")) {
    throw "Matrix runtime warnings differ from rust-dependency-policy.json. Expected [$($expectedShippingWarningKeys -join ', ')]; found [$($actualShippingWarningKeys -join ', ')]."
}
foreach ($expectedCount in $expectedRawWarningCounts.PSObject.Properties) {
    $actualCount = if ($warningCounts.Contains($expectedCount.Name)) { $warningCounts[$expectedCount.Name] } else { 0 }
    if ($actualCount -ne [int]$expectedCount.Value) {
        throw "Raw cargo-audit $($expectedCount.Name) warning count changed: expected $($expectedCount.Value), found $actualCount. Review policy rather than accepting drift."
    }
}
foreach ($actualCount in $warningCounts.GetEnumerator()) {
    if (-not ($expectedRawWarningCounts.PSObject.Properties.Name -contains $actualCount.Key)) {
        throw "Raw cargo-audit returned an unreviewed warning kind: $($actualCount.Key)."
    }
}
$actualBuildWarningKeys = @($actualBuildWarningKeys | Sort-Object -Unique)
if (($expectedBuildWarningKeys -join "`n") -ne ($actualBuildWarningKeys -join "`n")) {
    throw "Matrix build-tool warnings differ from rust-dependency-policy.json. Expected [$($expectedBuildWarningKeys -join ', ')]; found [$($actualBuildWarningKeys -join ', ')]."
}

$sourceSha = (& git -C $repoRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $sourceSha -notmatch '^[0-9a-f]{40}$') {
    throw "Could not bind the dependency report to the exact Git source SHA."
}
$report = [ordered]@{
    schemaVersion = 1
    sourceSha = $sourceSha
    cargoLockSha256 = (Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash.ToLowerInvariant()
    policySha256 = (Get-FileHash -LiteralPath $policyPath -Algorithm SHA256).Hash.ToLowerInvariant()
    shippingFeature = $shippingFeature
    shippingTarget = $shippingTarget
    matrixReleaseVulnerabilityCount = 0
    excludedNonShippingVulnerabilityCount = $expectedVulnerabilities.Count
    rawAuditVulnerabilityCount = $actualVulnerabilities.Count
    rawAuditWarningCounts = $warningCounts
    matrixRuntimeWarningCount = $actualShippingWarningKeys.Count
    matrixRuntimeWarnings = $actualShippingWarningKeys
    nonRuntimeBuildWarningCount = $actualBuildWarningKeys.Count
    excludedFeatures = @($policy.shipping.excludedFeatures)
    advisoryIds = @($expectedVulnerabilities | ForEach-Object { $_.id })
    rawAdvisories = @(
        $actualVulnerabilities |
            ForEach-Object {
                [ordered]@{
                    id = $_.advisory.id
                    package = $_.package.name
                    version = $_.package.version
                }
            }
    )
}

if (-not [string]::IsNullOrWhiteSpace($ReportPath)) {
    if (-not [IO.Path]::IsPathRooted($ReportPath)) {
        $ReportPath = Join-Path $repoRoot $ReportPath
    }
    $reportDirectory = Split-Path -Parent $ReportPath
    if (-not [string]::IsNullOrWhiteSpace($reportDirectory)) {
        New-Item -ItemType Directory -Force -Path $reportDirectory | Out-Null
    }
    $report | ConvertTo-Json -Depth 8 | Out-File $ReportPath -Encoding utf8
}

Write-Host "Matrix release dependency policy passed."
Write-Host "Shipping graph: $shippingFeature for $shippingTarget; 0 known RustSec vulnerabilities and $($actualShippingWarningKeys.Count) reviewed runtime warnings."
Write-Host "Raw lockfile audit: $($actualVulnerabilities.Count) vulnerability findings; all are confined to the explicitly non-shipping legacy graph."
Write-Host "Legacy findings remain visible and are not reported as fixed: $($actualKeys -join ', ')." -ForegroundColor Yellow
