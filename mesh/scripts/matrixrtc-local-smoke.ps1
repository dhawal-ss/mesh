[CmdletBinding()]
param(
    [ValidateRange(30, 300)]
    [int]$WaitTimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptRoot
$composePath = Join-Path $repoRoot "infra\matrixrtc\docker-compose.yml"
$environmentPath = Join-Path $repoRoot "infra\matrixrtc\.env.example"
$projectName = "mesh-matrixrtc-smoke"
$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker) {
    throw "Docker is required for the MatrixRTC local smoke."
}

$environmentNames = @(
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    "MATRIXRTC_LIVEKIT_HTTP_PORT",
    "MATRIXRTC_AUTH_HTTP_PORT",
    "MATRIXRTC_METRICS_PORT"
)
$originalEnvironment = @{}
foreach ($name in $environmentNames) {
    $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

function New-Base64UrlSecret([int]$ByteCount) {
    $bytes = New-Object byte[] $ByteCount
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Invoke-Compose([string[]]$Arguments) {
    & $docker.Source compose `
        -p $projectName `
        --env-file $environmentPath `
        -f $composePath `
        @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Compose command failed: $($Arguments -join ' ')"
    }
}

$started = $false
try {
    # These credentials exist only in this process and the disposable
    # containers. They are unrelated to every operator or production secret.
    $env:LIVEKIT_API_KEY = "local_$(New-Base64UrlSecret 12)"
    $env:LIVEKIT_API_SECRET = New-Base64UrlSecret 32
    # Avoid common developer ports such as 8080 while retaining the reviewed
    # container-side ports used by the proxy and service-to-service traffic.
    $env:MATRIXRTC_LIVEKIT_HTTP_PORT = "17880"
    $env:MATRIXRTC_AUTH_HTTP_PORT = "18080"
    $env:MATRIXRTC_METRICS_PORT = "16789"

    Invoke-Compose @(
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        [string]$WaitTimeoutSeconds
    )
    $started = $true

    $auth = Invoke-WebRequest `
        -UseBasicParsing `
        -Uri "http://127.0.0.1:18080/healthz" `
        -Method Get `
        -TimeoutSec 10
    if ($auth.StatusCode -ne 200) {
        throw "Authorization /healthz returned HTTP $($auth.StatusCode)."
    }

    $tokenlessStatus = $null
    try {
        Invoke-WebRequest `
            -UseBasicParsing `
            -Uri "http://127.0.0.1:17880/rtc" `
            -Headers @{
                Connection = "Upgrade"
                Upgrade = "websocket"
                "Sec-WebSocket-Key" = [Convert]::ToBase64String(
                    [Guid]::NewGuid().ToByteArray()
                )
                "Sec-WebSocket-Version" = "13"
            } `
            -TimeoutSec 10 | Out-Null
        $tokenlessStatus = 200
    } catch {
        if ($_.Exception.Response) {
            $tokenlessStatus = [int]$_.Exception.Response.StatusCode
        } else {
            throw
        }
    }
    if ($tokenlessStatus -ne 401) {
        throw "LiveKit tokenless signalling must return HTTP 401; received $tokenlessStatus."
    }

    $logs = & $docker.Source compose `
        -p $projectName `
        --env-file $environmentPath `
        -f $composePath `
        logs --no-color livekit
    if ($LASTEXITCODE -ne 0) {
        throw "Could not read disposable LiveKit logs."
    }
    $logText = [string]::Join("`n", @($logs))
    if ($logText -notmatch '"version":\s*"1\.13\.5"' -or
        $logText -notmatch '"turn\.relay_range_start":\s*50101' -or
        $logText -notmatch '"turn\.relay_range_end":\s*50200') {
        throw "LiveKit did not report the pinned version and bounded TURN relay range."
    }

    Write-Host "[PASS] Pinned MatrixRTC containers started with ephemeral local credentials." -ForegroundColor Green
    Write-Host "[PASS] Authorization health, tokenless SFU rejection, and bounded TURN relay startup were observed." -ForegroundColor Green
    Write-Host "This is a disposable local boot check, not authenticated media, TURN/TLS, or production acceptance." -ForegroundColor Yellow
} finally {
    try {
        & $docker.Source compose `
            -p $projectName `
            --env-file $environmentPath `
            -f $composePath `
            down --volumes --remove-orphans | Out-Host
    } finally {
        foreach ($name in $environmentNames) {
            [Environment]::SetEnvironmentVariable(
                $name,
                $originalEnvironment[$name],
                "Process"
            )
        }
    }
}
