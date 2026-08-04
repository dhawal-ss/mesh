[CmdletBinding()]
param(
    [switch]$Production,
    [switch]$Online,
    [string]$EnvironmentFile,
    [string]$WellKnownFile,
    [string]$AcceptanceEvidenceFile,
    [string]$EvidenceRoot,
    [switch]$RequireLiveAcceptance
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptRoot
$infraRoot = Join-Path $repoRoot "infra\matrixrtc"
$composePath = Join-Path $infraRoot "docker-compose.yml"
$nginxPath = Join-Path $infraRoot "nginx.example.conf"
$runbookPath = Join-Path $infraRoot "RUNBOOK.rst"
$acceptanceTemplatePath = Join-Path $infraRoot "acceptance-matrix.example.json"
$evidenceModulePath = Join-Path $infraRoot "MatrixRtcEvidence.psm1"
$packagePath = Join-Path $repoRoot "package.json"
$viteConfigPath = Join-Path $repoRoot "vite.config.ts"
$voiceHookPath = Join-Path $repoRoot "src\hooks\useVoiceEngine.ts"
$disabledVoicePath = Join-Path $repoRoot "src\lib\livekit-voice.disabled.ts"
$betaContractPath = Join-Path $repoRoot "release\beta-contract.json"
$sourceRoot = Split-Path -Parent $repoRoot
Import-Module $evidenceModulePath -Force

if (-not $EnvironmentFile) {
    $EnvironmentFile = Join-Path $infraRoot ".env.example"
}
if (-not $WellKnownFile) {
    $WellKnownFile = Join-Path $infraRoot "well-known.matrix-client.example.json"
}
if (-not $AcceptanceEvidenceFile) {
    $AcceptanceEvidenceFile = $acceptanceTemplatePath
} elseif (-not [IO.Path]::IsPathRooted($AcceptanceEvidenceFile)) {
    $AcceptanceEvidenceFile = Join-Path $repoRoot $AcceptanceEvidenceFile
}

$failures = [System.Collections.Generic.List[string]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()
$passes = [System.Collections.Generic.List[string]]::new()

function Add-Failure([string]$Message) {
    $script:failures.Add($Message)
}

function Add-Pass([string]$Message) {
    $script:passes.Add($Message)
}

function Get-EnvironmentMap([string]$Path) {
    $values = @{}
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Add-Failure "Environment file does not exist: $Path"
        return $values
    }

    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith("#")) {
            continue
        }
        $parts = $trimmed.Split("=", 2)
        if ($parts.Count -ne 2 -or -not $parts[0].Trim()) {
            Add-Failure "Invalid environment assignment: $trimmed"
            continue
        }
        $values[$parts[0].Trim()] = $parts[1].Trim().Trim('"').Trim("'")
    }
    return $values
}

function Test-AbsoluteServiceUri(
    [string]$Name,
    [string]$Value,
    [string]$ExpectedScheme,
    [string]$ExpectedPath
) {
    $parsed = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$parsed)) {
        Add-Failure "$Name must be an absolute URI."
        return
    }
    if ($parsed.Scheme -ne $ExpectedScheme) {
        Add-Failure "$Name must use $ExpectedScheme."
    }
    if ($parsed.UserInfo -or $parsed.Query -or $parsed.Fragment) {
        Add-Failure "$Name must not contain credentials, query parameters, or a fragment."
    }
    if ($parsed.AbsolutePath.TrimEnd("/") -ne $ExpectedPath) {
        Add-Failure "$Name must use the path $ExpectedPath."
    }
}

function Test-MatrixServerName([string]$Value) {
    if (-not $Value -or
        $Value.Length -gt 255 -or
        $Value -match "^[a-zA-Z][a-zA-Z0-9+.-]*://" -or
        $Value -match "[/?#@\s]" -or
        $Value -notmatch "^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[1-9][0-9]{0,4})?$") {
        return $false
    }

    $portMatch = [regex]::Match($Value, ":([0-9]+)$")
    return -not $portMatch.Success -or [int]$portMatch.Groups[1].Value -le 65535
}

foreach ($path in @(
    $composePath,
    $nginxPath,
    $runbookPath,
    $evidenceModulePath,
    $packagePath,
    $viteConfigPath,
    $voiceHookPath,
    $disabledVoicePath,
    $betaContractPath,
    $EnvironmentFile,
    $WellKnownFile,
    $AcceptanceEvidenceFile
)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Add-Failure "Required file does not exist: $path"
    }
}

if (Test-Path -LiteralPath $composePath) {
    $composeFailureCount = $failures.Count
    $compose = Get-Content -LiteralPath $composePath -Raw
    $liveKitImage = "image: livekit/livekit-server:v1.13.5@sha256:3497163e091d8418a915d41d99a2dfba6715e6b44a3ba662c979819b618f7af4"
    $authImage = "image: ghcr.io/element-hq/lk-jwt-service:0.4.4@sha256:9c715697c6f7c1f538f2ee41b7b59b04a8d06bf790a7cc8c8517ccac8d28813d"
    if ($compose -notmatch [regex]::Escape($liveKitImage)) {
        Add-Failure "LiveKit image must remain pinned to the reviewed v1.13.1 OCI manifest digest."
    }
    if ($compose -notmatch [regex]::Escape($authImage)) {
        Add-Failure "MatrixRTC Authorization Service must remain pinned to the reviewed 0.4.4 OCI manifest digest."
    }
    if ($compose -match "(?im)^\s*image:\s*\S+:latest\s*$") {
        Add-Failure "Mutable latest container tags are forbidden."
    }
    if ($compose -notmatch "(?ms)room:\s*\r?\n\s+auto_create:\s*false") {
        Add-Failure "LiveKit room.auto_create must be false for MatrixRTC authorization."
    }
    if ($compose -notmatch "(?ms)webhook:\s*\r?\n\s+api_key:\s+\$\{LIVEKIT_API_KEY:\?.*?\}\s*\r?\n\s+urls:\s*\r?\n\s+- http://matrixrtc-auth:8080/sfu_webhook") {
        Add-Failure "LiveKit must send signed participant lifecycle webhooks to the internal MatrixRTC Authorization Service."
    }
    if ($compose -notmatch "(?ms)livekit:\s*.*?depends_on:\s*\r?\n\s+matrixrtc-auth:\s*\r?\n\s+condition:\s*service_healthy" -or
        $compose -match "(?ms)matrixrtc-auth:\s*.*?depends_on:\s*\r?\n\s+- livekit") {
        Add-Failure "LiveKit must wait for the authorization webhook receiver to become healthy without a dependency cycle."
    }
    if ($compose -notmatch '(?ms)matrixrtc-auth:\s*.*?healthcheck:\s*\r?\n\s+test:\s*\["CMD",\s*"/lk-jwt-service-healthcheck"\]') {
        Add-Failure "The MatrixRTC Authorization Service must use its pinned image healthcheck binary."
    }
    if ($compose -notmatch 'LIVEKIT_SANITY_CHECK_INTERVAL_SECONDS:\s*"30"') {
        Add-Failure "The authorization service must retain the 30-second delegated-leave sanity check fallback."
    }
    if ($compose -notmatch [regex]::Escape('${MATRIXRTC_CONTROL_BIND:-127.0.0.1}:7880:7880/tcp') -or
        $compose -notmatch [regex]::Escape('${MATRIXRTC_CONTROL_BIND:-127.0.0.1}:8080:8080/tcp')) {
        Add-Failure "LiveKit and authorization control ports must default to loopback."
    }
    if ($compose -notmatch [regex]::Escape('${MATRIXRTC_METRICS_BIND:-127.0.0.1}:6789:6789/tcp')) {
        Add-Failure "LiveKit Prometheus metrics must default to a loopback-only bind."
    }
    if ($compose -notmatch [regex]::Escape('${MATRIXRTC_TURN_TLS_BIND:-127.0.0.1}:5349:5349/tcp')) {
        Add-Failure "The plaintext hop behind the TURN/TLS terminator must default to loopback."
    }
    foreach ($requiredMediaPort in @(
        '"7881:7881/tcp"',
        '"3478:3478/udp"',
        '"50000-50100:50000-50100/udp"'
    )) {
        if ($compose -notmatch [regex]::Escape($requiredMediaPort)) {
            Add-Failure "MatrixRTC Compose is missing required bounded media port $requiredMediaPort."
        }
    }
    if ($compose -notmatch "(?ms)turn:\s*\r?\n\s+enabled:\s*true" -or
        $compose -notmatch "external_tls:\s*true" -or
        $compose -notmatch 'domain:\s+\$\{LIVEKIT_TURN_DOMAIN:\?') {
        Add-Failure "LiveKit must retain explicit UDP TURN and externally terminated TURN/TLS configuration."
    }
    if ([regex]::Matches($compose, "(?ms)cap_drop:\s*\r?\n\s+- ALL").Count -lt 2 -or
        [regex]::Matches($compose, "no-new-privileges:true").Count -lt 2) {
        Add-Failure "Both MatrixRTC containers must drop Linux capabilities and forbid privilege escalation."
    }
    if ([regex]::Matches($compose, "(?ms)logging:\s*\r?\n\s+driver:\s+json-file").Count -lt 2 -or
        [regex]::Matches($compose, "max-size:\s+20m").Count -lt 2) {
        Add-Failure "Both MatrixRTC containers must use bounded local log rotation."
    }
    if ($compose -match "LIVEKIT_INSECURE_SKIP_VERIFY_TLS") {
        Add-Failure "TLS verification bypass must never be present in this deployment."
    }
    if ($failures.Count -eq $composeFailureCount) {
        Add-Pass "Pinned images and fail-closed Compose policy are present."
    }
}

if ((Test-Path -LiteralPath $packagePath) -and
    (Test-Path -LiteralPath $viteConfigPath) -and
    (Test-Path -LiteralPath $voiceHookPath) -and
    (Test-Path -LiteralPath $disabledVoicePath) -and
    (Test-Path -LiteralPath $betaContractPath)) {
    $buildFailureCount = $failures.Count
    $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
    $viteConfig = Get-Content -LiteralPath $viteConfigPath -Raw
    $voiceHook = Get-Content -LiteralPath $voiceHookPath -Raw
    $disabledVoice = Get-Content -LiteralPath $disabledVoicePath -Raw
    $betaContract = Get-Content -LiteralPath $betaContractPath -Raw | ConvertFrom-Json
    if ([string]$package.scripts.'build:matrix' -notmatch '--mode matrix(?:\s|$)') {
        Add-Failure "The public Matrix build must retain its text/community-only mode."
    }
    if ([string]$package.scripts.'build:matrix-voice' -notmatch '--mode matrix-voice(?:\s|$)') {
        Add-Failure "Physical MatrixRTC acceptance needs the separately named matrix-voice build."
    }
    if ($viteConfig -notmatch '__MESH_MATRIX_VOICE_FRONTEND__' -or
        $viteConfig -notmatch 'livekit-voice\.disabled\.ts') {
        Add-Failure "Vite must exclude the LiveKit implementation from builds that have not passed physical acceptance."
    }
    if ($voiceHook -notmatch 'Calling is not included in this text beta build' -or
        $disabledVoice -notmatch 'Calling is not included in this Mesh build') {
        Add-Failure "The renderer must fail closed when the Matrix media implementation is absent."
    }
    if (@($betaContract.candidate.excludedCapabilities) -notcontains 'matrix-voice' -or
        [bool]$betaContract.claims.voiceReady) {
        Add-Failure "The beta contract must keep Matrix voice excluded until live acceptance passes."
    }
    if ($failures.Count -eq $buildFailureCount) {
        Add-Pass "Text beta and physical MatrixRTC acceptance builds are mechanically separated."
    }
}

if (Test-Path -LiteralPath $nginxPath) {
    $nginxFailureCount = $failures.Count
    $nginx = Get-Content -LiteralPath $nginxPath -Raw
    foreach ($route in @("/livekit/jwt/", "/livekit/sfu/")) {
        if ($nginx -notmatch [regex]::Escape($route)) {
            Add-Failure "Reverse-proxy example is missing $route."
        }
    }
    if ($nginx -notmatch "(?ms)location\s+\^~\s+/livekit/jwt/sfu_webhook\s*\{\s*return\s+404;") {
        Add-Failure "The internal signed SFU webhook receiver must not be exposed through the public proxy."
    }
    if ($nginx -notmatch "proxy_set_header\s+Upgrade" -or $nginx -notmatch "proxy_buffering\s+off") {
        Add-Failure "LiveKit signalling proxy must support unbuffered WebSocket upgrades."
    }
    if ($nginx -notmatch "client_max_body_size\s+64k" -or
        $nginx -notmatch "limit_req_zone\s+.*matrixrtc_auth" -or
        $nginx -notmatch "limit_req\s+zone=matrixrtc_auth") {
        Add-Failure "Authorization proxy must bound request bodies and apply the matrixrtc_auth rate limit."
    }
    if ($nginx -notmatch "log_format\s+matrixrtc_safe" -or
        $nginx -notmatch 'matrixrtc_safe[\s\S]*\$request_method\s+\$uri\s+\$server_protocol' -or
        $nginx -notmatch "access_log\s+\S+\s+matrixrtc_safe") {
        Add-Failure "MatrixRTC access logs must use the query-redacting matrixrtc_safe format."
    }
    if ($failures.Count -eq $nginxFailureCount) {
        Add-Pass "Reverse-proxy routes include bounded auth traffic and WebSocket signalling."
    }
}

if (Test-Path -LiteralPath $runbookPath) {
    $runbookFailureCount = $failures.Count
    $runbook = Get-Content -LiteralPath $runbookPath -Raw
    foreach ($requiredRunbookText in @(
        "LIVEKIT_API_KEY",
        "LIVEKIT_API_SECRET",
        "--force-recreate",
        "matrixrtc-preflight.ps1",
        "operator-smoke.ps1",
        "MESH_RTC_ENABLED=0",
        "no uptime",
        "SLA",
        "3478",
        "5349",
        "50000-50100",
        "Resolve-DnsName",
        "Test-NetConnection",
        "caseId",
        "mediaE2eeActive",
        "mediaE2eeFailureClosed"
    )) {
        if ($runbook -notmatch [regex]::Escape($requiredRunbookText)) {
            Add-Failure "MatrixRTC runbook is missing required procedure text: $requiredRunbookText"
        }
    }
    if ($failures.Count -eq $runbookFailureCount) {
        Add-Pass "MatrixRTC restart, secret-rotation, rollback, and fail-closed runbook is present."
    }
}

$evidenceValidation = Test-MatrixRtcAcceptanceEvidence `
    -Path $AcceptanceEvidenceFile `
    -EvidenceRoot $EvidenceRoot `
    -SourceRoot $sourceRoot `
    -TrackedTemplatePath $acceptanceTemplatePath `
    -RequireComplete:$RequireLiveAcceptance
foreach ($message in $evidenceValidation.Passes) {
    Add-Pass $message
}
foreach ($message in $evidenceValidation.Failures) {
    Add-Failure $message
}
if ($RequireLiveAcceptance -and (-not $Production -or -not $Online)) {
    Add-Failure "-RequireLiveAcceptance requires both -Production and -Online."
}

$environment = Get-EnvironmentMap $EnvironmentFile
$required = @(
    "MESH_MATRIXRTC_LIVEKIT_SERVICE_URL",
    "MESH_MATRIXRTC_LIVEKIT_SFU_URL",
    "MATRIXRTC_MATRIX_SERVER_NAME",
    "MATRIXRTC_FULL_ACCESS_HOMESERVERS",
    "LIVEKIT_TURN_DOMAIN",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET"
)
foreach ($name in $required) {
    if (-not $environment.ContainsKey($name) -or -not $environment[$name]) {
        Add-Failure "Missing required environment value: $name"
    }
}

$docker = Get-Command docker -ErrorAction SilentlyContinue
if ($docker -and (Test-Path -LiteralPath $composePath) -and
    (Test-Path -LiteralPath $EnvironmentFile)) {
    & $docker.Source compose --env-file $EnvironmentFile -f $composePath config --quiet
    if ($LASTEXITCODE -ne 0) {
        Add-Failure "Docker Compose rejected the rendered MatrixRTC configuration."
    } else {
        Add-Pass "Docker Compose accepted the rendered configuration."
    }
} else {
    $warnings.Add("Docker CLI is unavailable; portable static checks ran, but Compose rendering was not verified.")
}

if ($environment.ContainsKey("MESH_MATRIXRTC_LIVEKIT_SERVICE_URL")) {
    Test-AbsoluteServiceUri "MESH_MATRIXRTC_LIVEKIT_SERVICE_URL" `
        $environment["MESH_MATRIXRTC_LIVEKIT_SERVICE_URL"] "https" "/livekit/jwt"
}
if ($environment.ContainsKey("MESH_MATRIXRTC_LIVEKIT_SFU_URL")) {
    Test-AbsoluteServiceUri "MESH_MATRIXRTC_LIVEKIT_SFU_URL" `
        $environment["MESH_MATRIXRTC_LIVEKIT_SFU_URL"] "wss" "/livekit/sfu"
}

if ($environment["MATRIXRTC_FULL_ACCESS_HOMESERVERS"] -eq "*") {
    Add-Failure "MATRIXRTC_FULL_ACCESS_HOMESERVERS must never be '*' because it grants room creation globally."
}
$fullAccessHomeservers = @(
    [string]$environment["MATRIXRTC_FULL_ACCESS_HOMESERVERS"] -split "," |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ }
)
foreach ($serverName in $fullAccessHomeservers) {
    if ($serverName -eq "*" -or -not (Test-MatrixServerName $serverName)) {
        Add-Failure "Invalid full-access Matrix server name: $serverName"
    }
}
if (-not (Test-MatrixServerName $environment["MATRIXRTC_MATRIX_SERVER_NAME"])) {
    Add-Failure "MATRIXRTC_MATRIX_SERVER_NAME must be a Matrix server name, not a URL."
} elseif ($environment["MATRIXRTC_MATRIX_SERVER_NAME"] -notin $fullAccessHomeservers) {
    Add-Failure "MATRIXRTC_FULL_ACCESS_HOMESERVERS must include MATRIXRTC_MATRIX_SERVER_NAME so local users can create calls."
}
if ($environment["LIVEKIT_TURN_DOMAIN"] -notmatch "^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])$" -or
    $environment["LIVEKIT_TURN_DOMAIN"] -notmatch "\.") {
    Add-Failure "LIVEKIT_TURN_DOMAIN must be a DNS hostname without a scheme, port, path, or wildcard."
} else {
    foreach ($publicUrlName in @(
        "MESH_MATRIXRTC_LIVEKIT_SERVICE_URL",
        "MESH_MATRIXRTC_LIVEKIT_SFU_URL"
    )) {
        $publicUri = $null
        if ([Uri]::TryCreate(
            $environment[$publicUrlName],
            [UriKind]::Absolute,
            [ref]$publicUri
        ) -and $publicUri.Host -eq $environment["LIVEKIT_TURN_DOMAIN"]) {
            Add-Failure "LIVEKIT_TURN_DOMAIN must use a separate hostname from $publicUrlName."
        }
    }
}

$wellKnown = $null
if (Test-Path -LiteralPath $WellKnownFile) {
    $wellKnownFailureCount = $failures.Count
    try {
        $wellKnown = Get-Content -LiteralPath $WellKnownFile -Raw | ConvertFrom-Json
        $focusProperty = $wellKnown.PSObject.Properties["org.matrix.msc4143.rtc_foci"]
        if (-not $focusProperty -or $focusProperty.Value.Count -lt 1) {
            Add-Failure "The .well-known document has no org.matrix.msc4143.rtc_foci entries."
        } else {
            $livekitFoci = @($focusProperty.Value | Where-Object { $_.type -eq "livekit" })
            if ($livekitFoci.Count -lt 1) {
                Add-Failure "The .well-known document has no LiveKit focus."
            } elseif ($environment["MESH_MATRIXRTC_LIVEKIT_SERVICE_URL"] -and
                $livekitFoci[0].livekit_service_url.TrimEnd("/") -ne
                $environment["MESH_MATRIXRTC_LIVEKIT_SERVICE_URL"].TrimEnd("/")) {
                Add-Failure "The .well-known LiveKit service URL does not match the operator environment."
            }
        }
        if ($failures.Count -eq $wellKnownFailureCount) {
            Add-Pass "The .well-known example parses and advertises a LiveKit focus."
        }
    } catch {
        Add-Failure "The .well-known document is not valid JSON: $($_.Exception.Message)"
    }
}

if ($Production) {
    $productionFailureCount = $failures.Count
    $warnings.Add(
        "This preflight validates the single-node beta baseline only; it does not certify HA, auth-service state continuity, monitoring, backups, rollback, or certificate operations."
    )
    foreach ($entry in $environment.GetEnumerator()) {
        if ($entry.Value -match "(?i)REPLACE_|example\.com|localhost|changeme|devkey") {
            Add-Failure "Production value $($entry.Key) still contains an example or placeholder."
        }
    }
    if ($environment["MATRIXRTC_CONTROL_BIND"] -and
        $environment["MATRIXRTC_CONTROL_BIND"] -notin @("127.0.0.1", "::1")) {
        Add-Failure "Production control ports must bind only to loopback."
    }
    if ($environment["MATRIXRTC_METRICS_BIND"] -and
        $environment["MATRIXRTC_METRICS_BIND"] -notin @("127.0.0.1", "::1")) {
        Add-Failure "Production metrics must bind only to loopback."
    }
    if ($environment["MATRIXRTC_TURN_TLS_BIND"] -and
        $environment["MATRIXRTC_TURN_TLS_BIND"] -notin @("127.0.0.1", "::1")) {
        Add-Failure "The default production TURN/TLS plaintext hop must bind only to loopback."
    }
    if ($environment["LIVEKIT_API_KEY"].Length -lt 12) {
        Add-Failure "LIVEKIT_API_KEY must be at least 12 characters in production."
    }
    if ($environment["LIVEKIT_API_SECRET"].Length -lt 32) {
        Add-Failure "LIVEKIT_API_SECRET must be at least 32 characters in production."
    }
    if ($environment["LIVEKIT_API_KEY"] -notmatch "^[A-Za-z0-9_-]{12,128}$") {
        Add-Failure "LIVEKIT_API_KEY must use 12-128 base64url-safe characters."
    }
    if ($environment["LIVEKIT_API_SECRET"] -notmatch "^[A-Za-z0-9_-]{32,256}$") {
        Add-Failure "LIVEKIT_API_SECRET must use 32-256 base64url-safe characters."
    }
    if ($environment["LIVEKIT_API_KEY"] -eq $environment["LIVEKIT_API_SECRET"]) {
        Add-Failure "LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be different."
    }
    if ($failures.Count -eq $productionFailureCount) {
        Add-Pass "Production placeholder, allowlist, bind, and credential policy checked."
    }
}

if ($Online -and $failures.Count -eq 0) {
    Add-Type -AssemblyName System.Net.Http

    try {
        $authBase = $environment["MESH_MATRIXRTC_LIVEKIT_SERVICE_URL"].TrimEnd("/")
        $health = Invoke-WebRequest -Uri "$authBase/healthz" -Method Get -TimeoutSec 10
        if ($health.StatusCode -lt 200 -or $health.StatusCode -ge 300) {
            Add-Failure "Authorization health endpoint returned HTTP $($health.StatusCode)."
        } else {
            Add-Pass "Authorization health endpoint is reachable over HTTPS."
        }
    } catch {
        Add-Failure "Authorization health endpoint failed: $($_.Exception.Message)"
    }

    try {
        $sfuUri = [Uri]$environment["MESH_MATRIXRTC_LIVEKIT_SFU_URL"]
        $probeBuilder = [UriBuilder]::new($sfuUri)
        $probeBuilder.Scheme = if ($sfuUri.Scheme -eq "wss") { "https" } else { "http" }
        if ($probeBuilder.Port -eq 80 -or $probeBuilder.Port -eq 443) {
            $probeBuilder.Port = -1
        }
        $probeBuilder.Path = "$($probeBuilder.Path.TrimEnd('/'))/rtc"

        $handler = [System.Net.Http.HttpClientHandler]::new()
        $http = [System.Net.Http.HttpClient]::new($handler)
        $http.Timeout = [TimeSpan]::FromSeconds(10)
        $request = [System.Net.Http.HttpRequestMessage]::new(
            [System.Net.Http.HttpMethod]::Get,
            $probeBuilder.Uri
        )
        $request.Version = [Version]::new(1, 1)
        $request.Headers.TryAddWithoutValidation("Connection", "Upgrade") | Out-Null
        $request.Headers.TryAddWithoutValidation("Upgrade", "websocket") | Out-Null
        $request.Headers.TryAddWithoutValidation(
            "Sec-WebSocket-Key",
            [Convert]::ToBase64String([Guid]::NewGuid().ToByteArray())
        ) | Out-Null
        $request.Headers.TryAddWithoutValidation("Sec-WebSocket-Version", "13") | Out-Null
        $response = $http.SendAsync($request).GetAwaiter().GetResult()
        $statusCode = [int]$response.StatusCode
        if ($statusCode -eq 101) {
            Add-Failure "Public SFU signalling accepted an unauthenticated WebSocket upgrade."
        } elseif ($statusCode -ne 401) {
            Add-Failure "Public SFU signalling route must reject the tokenless upgrade with HTTP 401; received HTTP $statusCode."
        } else {
            Add-Pass "Public SFU signalling route and trusted TLS returned the pinned server's expected tokenless HTTP 401."
        }
        $response.Dispose()
        $request.Dispose()
        $http.Dispose()
        $handler.Dispose()
    } catch {
        Add-Failure "Public SFU signalling route or trusted TLS failed: $($_.Exception.Message)"
    }

    try {
        $matrixServerName = $environment["MATRIXRTC_MATRIX_SERVER_NAME"]
        $discoveryUri = [Uri]"https://$matrixServerName/.well-known/matrix/client"
        $response = Invoke-WebRequest -Uri $discoveryUri -Method Get -TimeoutSec 10
        $contentType = [string]$response.Headers["Content-Type"]
        if ($contentType -notmatch "(?i)^application/json(?:;|$)") {
            Add-Failure "Public .well-known must use application/json; received '$contentType'."
        }
        $publicDocument = $response.Content | ConvertFrom-Json
        $publicFoci = @($publicDocument.PSObject.Properties["org.matrix.msc4143.rtc_foci"].Value)
        if (-not ($publicFoci | Where-Object {
            $_.type -eq "livekit" -and
            $_.livekit_service_url.TrimEnd("/") -eq $environment["MESH_MATRIXRTC_LIVEKIT_SERVICE_URL"].TrimEnd("/")
        })) {
            Add-Failure "Public .well-known does not advertise the expected LiveKit authorization URL."
        }
        $cors = [string]$response.Headers["Access-Control-Allow-Origin"]
        if ($cors -ne "*") {
            if ($Production) {
                Add-Failure "Public .well-known must advertise Access-Control-Allow-Origin: * for Matrix clients."
            } else {
                $warnings.Add("Public .well-known does not advertise wildcard CORS; verify every supported Mesh origin.")
            }
        }
        Add-Pass "Public Matrix discovery is reachable and consistent."
    } catch {
        Add-Failure "Public Matrix discovery failed: $($_.Exception.Message)"
    }

    try {
        $turnDomain = $environment["LIVEKIT_TURN_DOMAIN"]
        $turnAddresses = [System.Net.Dns]::GetHostAddresses($turnDomain)
        if ($turnAddresses.Count -lt 1) {
            throw "hostname resolved without an address"
        }
        Add-Pass "TURN/TLS hostname resolves through trusted DNS."

        $turnTcp = [System.Net.Sockets.TcpClient]::new()
        $connectTask = $turnTcp.ConnectAsync($turnDomain, 5349)
        if (-not $connectTask.Wait([TimeSpan]::FromSeconds(10))) {
            throw "TCP 5349 connection timed out"
        }
        $turnTls = [System.Net.Security.SslStream]::new(
            $turnTcp.GetStream(),
            $false
        )
        $turnTls.AuthenticateAsClient($turnDomain)
        Add-Pass "TURN/TLS listener presented a trusted certificate for the configured hostname."
        $turnTls.Dispose()
        $turnTcp.Dispose()
    } catch {
        Add-Failure "TURN/TLS DNS, TCP 5349, or trusted-certificate probe failed: $($_.Exception.Message)"
    }

    $warnings.Add(
        "Online preflight does not prove OpenID token exchange, authorization-to-SFU API credentials, media reachability, or TURN. Run the real two-party/federated call and TURN acceptance gates."
    )
}

Write-Host ""
foreach ($message in $passes) {
    Write-Host "[PASS] $message" -ForegroundColor Green
}
foreach ($message in $warnings) {
    Write-Host "[WARN] $message" -ForegroundColor Yellow
}
foreach ($message in $failures) {
    Write-Host "[FAIL] $message" -ForegroundColor Red
}

if ($failures.Count -gt 0) {
    Write-Host ""
    Write-Host "MatrixRTC preflight failed with $($failures.Count) error(s)." -ForegroundColor Red
    exit 1
}

Write-Host ""
if ($Production -and $Online) {
    Write-Host "MatrixRTC single-node configuration, auth liveness, signalling route, and discovery passed beta preflight. Authenticated media, TURN, and resilience are not certified." -ForegroundColor Green
} elseif ($Production) {
    Write-Host "MatrixRTC single-node operator configuration passed offline beta preflight. Run again with -Online after deployment; resilience is not certified." -ForegroundColor Green
} else {
    Write-Host "MatrixRTC configuration validated; no live evidence collected. This does not authorize production deployment." -ForegroundColor Green
}
