# probe-turn.ps1 — Probe a real deployed TURN server using Mesh's RFC 5766
# Allocate-with-HMAC-SHA1 implementation.
#
# PowerShell equivalent of probe-turn.sh for Windows operators.
#
# Usage:
#   .\scripts\probe-turn.ps1 -Url turn:turn.example.com:3478 -Username alice -Password hunter2
#
# Or with environment variables:
#   $env:MESH_TURN_URL = "turn:turn.example.com:3478"
#   $env:MESH_TURN_USERNAME = "alice"
#   $env:MESH_TURN_PASSWORD = "hunter2"
#   .\scripts\probe-turn.ps1
#
# Regression mode: set $env:MESH_TURN_EXPECT to assert a specific outcome.

[CmdletBinding()]
param(
    [string]$Url,
    [string]$Username,
    [string]$Password,
    [string]$Expect
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot = Split-Path -Parent $ScriptDir

# Map parameters to env vars (parameters win over existing env vars)
if ($Url)      { $env:MESH_TURN_URL      = $Url      }
if ($Username) { $env:MESH_TURN_USERNAME = $Username }
if ($Password) { $env:MESH_TURN_PASSWORD = $Password }
if ($Expect)   { $env:MESH_TURN_EXPECT   = $Expect   }

if (-not $env:MESH_TURN_URL -or -not $env:MESH_TURN_USERNAME -or -not $env:MESH_TURN_PASSWORD) {
    Write-Host "Usage: .\scripts\probe-turn.ps1 -Url <turn-url> -Username <user> -Password <pass>"
    Write-Host ""
    Write-Host "  -Url       e.g. turn:turn.example.com:3478"
    Write-Host "  -Username  TURN long-term credential username"
    Write-Host "  -Password  TURN long-term credential password"
    Write-Host "  -Expect    (optional) assert a specific outcome"
    Write-Host ""
    Write-Host "Or set MESH_TURN_URL, MESH_TURN_USERNAME, MESH_TURN_PASSWORD."
    exit 1
}

Set-Location (Join-Path $RepoRoot "src-tauri")

Write-Host "────────────────────────────────────────────────"
Write-Host "  Mesh TURN Probe"
Write-Host "────────────────────────────────────────────────"
Write-Host "  URL:      $env:MESH_TURN_URL"
Write-Host "  Username: $env:MESH_TURN_USERNAME"
Write-Host "  Password: ***"
if ($env:MESH_TURN_EXPECT) {
    Write-Host "  Expect:   $env:MESH_TURN_EXPECT (regression mode)"
}
Write-Host "────────────────────────────────────────────────"
Write-Host ""

$exitCode = 0
try {
    & cargo test --no-default-features --features legacy-p2p --locked --jobs 1 --test turn_probe_live_tests -- --ignored --nocapture probes_real_turn_server_with_credentials
    $exitCode = $LASTEXITCODE
}
catch {
    $exitCode = 1
    Write-Host "✗ Probe execution failed: $_"
}

Write-Host ""
if ($exitCode -eq 0) {
    Write-Host "✓ Probe completed. Review the output above for outcome classification."
} else {
    Write-Host "✗ Probe failed. Check logs above and verify:"
    Write-Host "   - TURN server is running and reachable on the given port"
    Write-Host "   - UDP is not blocked by a firewall between you and the server"
    Write-Host "   - Credentials match the TURN long-term credential config"
}
exit $exitCode
