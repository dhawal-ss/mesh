# nightly-soak.ps1 — PowerShell equivalent of nightly-soak.sh
#
# Runs Mesh's long-duration soak and leak-detection tests and captures
# output to a timestamped log file. Intended for nightly CI or manual
# regression runs before releases.
#
# Usage:
#   .\scripts\nightly-soak.ps1                  # run everything
#   .\scripts\nightly-soak.ps1 -SoakOnly        # skip fast live tests
#   .\scripts\nightly-soak.ps1 -FastOnly        # skip 60s+ soak tests

[CmdletBinding()]
param(
    [switch]$SoakOnly,
    [switch]$FastOnly
)

$ErrorActionPreference = "Continue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot = Split-Path -Parent $ScriptDir
$LogDir = Join-Path $RepoRoot "soak-logs"
$Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$LogFile = Join-Path $LogDir "soak-$Timestamp.log"

if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir | Out-Null
}

function Write-Log {
    param([string]$Message)
    $line = "[$(Get-Date -Format HH:mm:ss)] $Message"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line
}

function Invoke-Test {
    param(
        [string]$Label,
        [string]$Command,
        [string[]]$Arguments
    )
    Write-Log "── $Label ──"
    & $Command @Arguments 2>&1 | Tee-Object -FilePath $LogFile -Append
    if ($LASTEXITCODE -eq 0) {
        Write-Log "✓ $Label PASSED"
        return $true
    } else {
        Write-Log "✗ $Label FAILED"
        return $false
    }
}

Set-Location (Join-Path $RepoRoot "src-tauri")

Write-Log "Mesh nightly soak regression starting"
Write-Log "Repo: $RepoRoot"
Write-Log "Log:  $LogFile"
Write-Log ""

$failedCount = 0

if (-not $SoakOnly) {
    $ok = Invoke-Test -Label "fast live libp2p tests (13 tests, ~70s)" `
        -Command "cargo" `
        -Arguments @(
            "test", "--no-default-features", "--features", "legacy-p2p",
            "--locked", "--jobs", "1", "--test", "live_network_tests",
            "--", "--ignored", "--test-threads=1",
            "--skip", "leak_detection_soak_60s",
            "--skip", "repeated_topology_churn_45s"
        )
    if (-not $ok) { $failedCount++ }
}

if (-not $FastOnly) {
    $ok = Invoke-Test -Label "60s leak-detection soak" `
        -Command "cargo" `
        -Arguments @(
            "test", "--no-default-features", "--features", "legacy-p2p",
            "--locked", "--jobs", "1", "--test", "live_network_tests",
            "leak_detection_soak_60s",
            "--", "--ignored", "--nocapture"
        )
    if (-not $ok) { $failedCount++ }

    $ok = Invoke-Test -Label "45s topology churn soak" `
        -Command "cargo" `
        -Arguments @(
            "test", "--no-default-features", "--features", "legacy-p2p",
            "--locked", "--jobs", "1", "--test", "live_network_tests",
            "repeated_topology_churn_45s",
            "--", "--ignored", "--nocapture"
        )
    if (-not $ok) { $failedCount++ }
}

Write-Log ""
Write-Log "──────────────────────────────────────────"
if ($failedCount -eq 0) {
    Write-Log "✓ ALL TESTS PASSED"
    Write-Log "Log saved to $LogFile"
    exit 0
} else {
    Write-Log "✗ $failedCount test group(s) FAILED"
    Write-Log "Log saved to $LogFile"
    exit 1
}
