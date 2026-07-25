# Probe a real deployed TURN server using Mesh's RFC 5766
# Allocate-with-HMAC-SHA1 implementation.
#
# Prefer process-scoped environment variables so credentials do not appear in
# shell history or process arguments:
#   $env:MESH_TURN_URL = "turn:turn.example.com:3478"
#   $env:MESH_TURN_USERNAME = "alice"
#   $env:MESH_TURN_PASSWORD = "<short-lived credential>"
#   $env:MESH_TURN_EXPECT = "allocation_ok"
#   .\scripts\probe-turn.ps1

[CmdletBinding()]
param(
    [string]$Url,
    [string]$Username,
    [string]$Password,
    [string]$Expect
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$repoRoot = Split-Path -Parent $scriptDir

$originalEnvironment = @{}
foreach ($name in @(
    "MESH_TURN_URL",
    "MESH_TURN_USERNAME",
    "MESH_TURN_PASSWORD",
    "MESH_TURN_EXPECT"
)) {
    $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

function Restore-ProbeEnvironment {
    foreach ($entry in $originalEnvironment.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable(
            [string]$entry.Key,
            $entry.Value,
            "Process"
        )
    }
}

# Parameters remain for compatibility. Environment injection is preferred.
if ($Url) { $env:MESH_TURN_URL = $Url }
if ($Username) { $env:MESH_TURN_USERNAME = $Username }
if ($Password) { $env:MESH_TURN_PASSWORD = $Password }
if ($Expect) { $env:MESH_TURN_EXPECT = $Expect }

if ($Password) {
    Write-Warning "Passing TURN credentials as command arguments can expose them in shell history. Prefer process-scoped MESH_TURN_* environment variables."
}

if (-not $env:MESH_TURN_URL -or
    -not $env:MESH_TURN_USERNAME -or
    -not $env:MESH_TURN_PASSWORD) {
    Write-Host "Set MESH_TURN_URL, MESH_TURN_USERNAME, and MESH_TURN_PASSWORD."
    Write-Host "Optional: set MESH_TURN_EXPECT to allocation_ok for a strict UDP Allocate check."
    Restore-ProbeEnvironment
    exit 1
}

if ($env:MESH_TURN_URL.StartsWith("turns:", [StringComparison]::OrdinalIgnoreCase) -and
    $env:MESH_TURN_EXPECT -eq "allocation_ok") {
    Write-Host "The standalone probe cannot validate TLS or Allocate for turns: URLs."
    Write-Host "Use turn: for the authenticated UDP Allocate probe, then prove TURN/TLS with a relay-only client call."
    Restore-ProbeEnvironment
    exit 1
}

Write-Host "Mesh TURN probe"
Write-Host "  URL:      $env:MESH_TURN_URL"
Write-Host "  Username: $env:MESH_TURN_USERNAME"
Write-Host "  Password: [REDACTED]"
if ($env:MESH_TURN_EXPECT) {
    Write-Host "  Expect:   $env:MESH_TURN_EXPECT"
}

$exitCode = 1
Push-Location (Join-Path $repoRoot "src-tauri")
try {
    & cargo test `
        --no-default-features `
        --features legacy-p2p `
        --locked `
        --jobs 1 `
        --test turn_probe_live_tests `
        -- `
        --ignored `
        --nocapture `
        probes_real_turn_server_with_credentials
    $exitCode = $LASTEXITCODE
} catch {
    Write-Host "Probe execution failed."
    $exitCode = 1
} finally {
    Pop-Location
    Restore-ProbeEnvironment
}

if ($exitCode -eq 0) {
    Write-Host "Probe completed. Review the outcome classification above."
} else {
    Write-Host "Probe failed. Verify endpoint reachability, transport, and credentials."
}
exit $exitCode
