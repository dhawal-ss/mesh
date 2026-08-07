[CmdletBinding()]
param(
    [switch]$Production,
    [switch]$Online,
    [ValidateSet("R2", "R3")]
    [string]$Milestone = "R2",
    [string]$EnvironmentFile = "",
    [ValidateRange(3, 60)]
    [int]$TimeoutSeconds = 15,
    [ValidateRange(2, 5)]
    [int]$PublicProbeAttempts = 3
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptRoot
if ([string]::IsNullOrWhiteSpace($EnvironmentFile)) {
    $EnvironmentFile = Join-Path $repoRoot "infra/operator-smoke/.env.example"
} elseif (-not [IO.Path]::IsPathRooted($EnvironmentFile)) {
    $EnvironmentFile = Join-Path $repoRoot $EnvironmentFile
}

$passes = [System.Collections.Generic.List[string]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()
$failures = [System.Collections.Generic.List[string]]::new()
$sensitiveValues = [System.Collections.Generic.List[string]]::new()

function Add-Pass([string]$Message) {
    $script:passes.Add($Message)
}

function Add-Warning([string]$Message) {
    $script:warnings.Add($Message)
}

function Add-Failure([string]$Message) {
    $script:failures.Add($Message)
}

function Assert-Check {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Get-SafeErrorMessage([Exception]$ErrorRecord) {
    $message = [string]$ErrorRecord.Message
    foreach ($secret in $script:sensitiveValues) {
        if (-not [string]::IsNullOrWhiteSpace($secret)) {
            $message = $message.Replace($secret, "[REDACTED]")
        }
    }
    return $message
}

function Invoke-LiveCheck {
    param(
        [string]$Name,
        [scriptblock]$Check
    )

    try {
        & $Check
        Add-Pass $Name
    } catch {
        Add-Failure "${Name}: $(Get-SafeErrorMessage $_.Exception)"
    }
}

function Read-PublicEnvironmentFile([string]$Path) {
    $values = [Collections.Generic.Dictionary[string, string]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Add-Failure "Configuration file does not exist: $Path"
        return $values
    }

    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith("#")) {
            continue
        }

        $parts = $trimmed.Split("=", 2)
        if ($parts.Count -ne 2 -or [string]::IsNullOrWhiteSpace($parts[0])) {
            Add-Failure "Invalid configuration assignment: $trimmed"
            continue
        }

        $name = $parts[0].Trim()
        $value = $parts[1].Trim().Trim('"').Trim("'")
        if ($name -match '(?i)(TOKEN|PASSWORD|SECRET|CREDENTIAL|API_KEY|PRIVATE_KEY)') {
            Add-Failure "Secret-like setting $name is forbidden in the configuration file; inject it through the process environment."
            continue
        }
        if ($values.ContainsKey($name)) {
            Add-Failure "Duplicate configuration setting: $name"
            continue
        }
        $values.Add($name, $value)
    }
    return $values
}

function Get-RequiredConfig {
    param(
        [Collections.Generic.Dictionary[string, string]]$Values,
        [string]$Name
    )

    if (-not $Values.ContainsKey($Name) -or
        [string]::IsNullOrWhiteSpace($Values[$Name])) {
        Add-Failure "Missing required public configuration: $Name"
        return ""
    }
    return $Values[$Name]
}

function Test-ServiceUri {
    param(
        [string]$Name,
        [string]$Value,
        [string[]]$Schemes,
        [switch]$AllowQuery,
        [switch]$AllowPath
    )

    $parsed = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$parsed)) {
        Add-Failure "$Name must be an absolute URI."
        return
    }
    if ($parsed.Scheme -notin $Schemes) {
        Add-Failure "$Name must use one of: $($Schemes -join ', ')."
    }
    if ($parsed.UserInfo -or $parsed.Fragment) {
        Add-Failure "$Name must not contain credentials or a fragment."
    }
    if (-not $AllowQuery -and $parsed.Query) {
        Add-Failure "$Name must not contain a query string."
    }
    if (-not $AllowPath -and $parsed.AbsolutePath -ne "/") {
        Add-Failure "$Name must be an origin without a path."
    }
}

function Get-IceEndpoint([string]$Name, [string]$Value, [string]$ExpectedScheme) {
    $match = [regex]::Match(
        $Value,
        "^(?<scheme>turn|turns):(?<host>\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+)(?::(?<port>[0-9]{1,5}))?(?:\?transport=(?<transport>udp|tcp))?$",
        [Text.RegularExpressions.RegexOptions]::IgnoreCase
    )
    if (-not $match.Success) {
        Add-Failure "$Name must be an ICE URL using $ExpectedScheme with a host and optional port/transport."
        return $null
    }

    $scheme = $match.Groups["scheme"].Value.ToLowerInvariant()
    if ($scheme -ne $ExpectedScheme) {
        Add-Failure "$Name must use $ExpectedScheme. UDP Allocate and TURN/TLS reachability are separate evidence."
    }

    $port = if ($match.Groups["port"].Success) {
        [int]$match.Groups["port"].Value
    } elseif ($scheme -eq "turns") {
        5349
    } else {
        3478
    }
    if ($port -lt 1 -or $port -gt 65535) {
        Add-Failure "$Name contains an invalid port."
        return $null
    }

    $endpointHost = $match.Groups["host"].Value.Trim("[", "]")
    return [PSCustomObject]@{
        Scheme = $scheme
        Host = $endpointHost
        Port = $port
        Transport = $match.Groups["transport"].Value.ToLowerInvariant()
    }
}

function Test-TurnTlsTransport([string]$Url, [int]$TimeoutMilliseconds) {
    $endpoint = Get-IceEndpoint "MESH_SMOKE_TURN_TLS_URL" $Url "turns"
    Assert-Check ($null -ne $endpoint -and $endpoint.Scheme -eq "turns") `
        "TURN/TLS endpoint could not be parsed."

    $tcp = [Net.Sockets.TcpClient]::new()
    try {
        $pending = $tcp.BeginConnect($endpoint.Host, $endpoint.Port, $null, $null)
        try {
            Assert-Check ($pending.AsyncWaitHandle.WaitOne($TimeoutMilliseconds)) `
                "TURN/TLS TCP connection timed out."
            $tcp.EndConnect($pending)
        } finally {
            $pending.AsyncWaitHandle.Dispose()
        }

        $tls = [Net.Security.SslStream]::new($tcp.GetStream(), $false)
        try {
            $tls.ReadTimeout = $TimeoutMilliseconds
            $tls.WriteTimeout = $TimeoutMilliseconds
            $tls.AuthenticateAsClient($endpoint.Host)
            Assert-Check $tls.IsAuthenticated "TURN/TLS handshake did not authenticate."
            Assert-Check $tls.IsEncrypted "TURN/TLS transport is not encrypted."
        } finally {
            $tls.Dispose()
        }
    } finally {
        $tcp.Dispose()
    }
}

function Get-PropertyValue {
    param(
        [object]$Object,
        [string]$Name
    )

    if ($null -eq $Object) {
        return $null
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }
    return $property.Value
}

function Get-ProcessSecret([string]$Name) {
    $value = [Environment]::GetEnvironmentVariable($Name)
    if (-not [string]::IsNullOrWhiteSpace($value)) {
        $script:sensitiveValues.Add($value)
    }
    return $value
}

function Test-PublicIpAddress([Net.IPAddress]$Address) {
    if ([Net.IPAddress]::IsLoopback($Address) -or $Address.Equals([Net.IPAddress]::Any) -or
        $Address.Equals([Net.IPAddress]::IPv6Any)) {
        return $false
    }
    if ($Address.IsIPv4MappedToIPv6) {
        return Test-PublicIpAddress $Address.MapToIPv4()
    }

    $bytes = $Address.GetAddressBytes()
    if ($Address.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork) {
        if ($bytes[0] -eq 0 -or $bytes[0] -eq 10 -or $bytes[0] -eq 127 -or
            ($bytes[0] -eq 100 -and $bytes[1] -ge 64 -and $bytes[1] -le 127) -or
            ($bytes[0] -eq 169 -and $bytes[1] -eq 254) -or
            ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or
            ($bytes[0] -eq 192 -and $bytes[1] -eq 168) -or
            ($bytes[0] -eq 192 -and $bytes[1] -eq 0 -and $bytes[2] -eq 2) -or
            ($bytes[0] -eq 198 -and $bytes[1] -eq 51 -and $bytes[2] -eq 100) -or
            ($bytes[0] -eq 203 -and $bytes[1] -eq 0 -and $bytes[2] -eq 113) -or
            $bytes[0] -ge 224) {
            return $false
        }
        return $true
    }

    # Reject unique-local, link-local, multicast, and documentation IPv6.
    if (($bytes[0] -band 0xFE) -eq 0xFC -or
        ($bytes[0] -eq 0xFE -and ($bytes[1] -band 0xC0) -eq 0x80) -or
        $bytes[0] -eq 0xFF -or
        ($bytes[0] -eq 0x20 -and $bytes[1] -eq 0x01 -and
            $bytes[2] -eq 0x0D -and $bytes[3] -eq 0xB8)) {
        return $false
    }
    return $true
}

function Assert-PublicDnsResolution([string]$ServiceHost) {
    try {
        $addresses = @([Net.Dns]::GetHostAddresses($ServiceHost))
    } catch {
        throw "Public DNS resolution failed for $ServiceHost."
    }
    Assert-Check ($addresses.Count -gt 0 -and $addresses.Count -le 16) `
        "Public DNS for $ServiceHost returned no addresses or too many addresses."
    foreach ($address in $addresses) {
        Assert-Check (Test-PublicIpAddress $address) `
            "Public evidence cannot use the private or non-routable DNS answer returned for $ServiceHost. Run this check from a genuinely external network."
    }
    Add-Pass "External-vantage DNS for $ServiceHost resolved only public addresses."
}

Add-Type -AssemblyName System.Net.Http

function New-SmokeHttpClient {
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $true
    $handler.MaxAutomaticRedirections = 3
    $client = [Net.Http.HttpClient]::new($handler, $true)
    $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
    $client.DefaultRequestHeaders.UserAgent.ParseAdd("Mesh-Operator-Smoke/1.0")
    return $client
}

function Read-BoundedResponseBytes {
    param(
        [Net.Http.HttpContent]$Content,
        [ValidateRange(1, 10485760)]
        [int]$MaximumBytes
    )

    $contentLength = $Content.Headers.ContentLength
    if ($null -ne $contentLength) {
        Assert-Check ([long]$contentLength -le $MaximumBytes) `
            "Response exceeded the $MaximumBytes-byte limit."
    }

    $stream = $null
    $buffer = [byte[]]::new(8192)
    $output = [IO.MemoryStream]::new([Math]::Min($MaximumBytes, 65536))
    try {
        $stream = $Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $received = 0
        while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $received += $read
            Assert-Check ($received -le $MaximumBytes) `
                "Response exceeded the $MaximumBytes-byte limit while downloading."
            $output.Write($buffer, 0, $read)
        }
        return $output.ToArray()
    } finally {
        if ($null -ne $stream) {
            $stream.Dispose()
        }
        $output.Dispose()
    }
}

function Invoke-JsonRequest {
    param(
        [Net.Http.HttpClient]$Client,
        [string]$Uri,
        [string]$Method = "GET",
        [string]$BearerToken = "",
        [object]$Body = $null,
        [int]$MaximumBytes = 1048576
    )

    $parsed = $null
    Assert-Check ([Uri]::TryCreate($Uri, [UriKind]::Absolute, [ref]$parsed)) `
        "Request URI is invalid."
    Assert-Check ($parsed.Scheme -eq "https") "Live HTTP checks require HTTPS."
    Assert-Check ([string]::IsNullOrEmpty($parsed.UserInfo)) `
        "Request URI must not contain credentials."

    $request = [Net.Http.HttpRequestMessage]::new(
        [Net.Http.HttpMethod]::new($Method),
        $parsed
    )
    if (-not [string]::IsNullOrWhiteSpace($BearerToken)) {
        $request.Headers.Authorization =
            [Net.Http.Headers.AuthenticationHeaderValue]::new("Bearer", $BearerToken)
    }
    if ($null -ne $Body) {
        $jsonBody = $Body | ConvertTo-Json -Depth 20 -Compress
        $request.Content = [Net.Http.StringContent]::new(
            $jsonBody,
            [Text.Encoding]::UTF8,
            "application/json"
        )
    }

    $response = $null
    try {
        $response = $Client.SendAsync(
            $request,
            [Net.Http.HttpCompletionOption]::ResponseHeadersRead
        ).GetAwaiter().GetResult()
        $statusCode = [int]$response.StatusCode
        Assert-Check ($response.IsSuccessStatusCode) "HTTP $statusCode."
        Assert-Check ($response.RequestMessage.RequestUri.Scheme -eq "https") `
            "Redirected response left HTTPS."

        $bytes = Read-BoundedResponseBytes `
            -Content $response.Content `
            -MaximumBytes $MaximumBytes
        $contentType = [string]$response.Content.Headers.ContentType.MediaType
        Assert-Check ($contentType -match '(?i)^(application|text)/(.+\+)?json$') `
            "Expected JSON content type; received '$contentType'."

        $text = [Text.Encoding]::UTF8.GetString($bytes)
        $json = $text | ConvertFrom-Json
        return [PSCustomObject]@{
            Json = $json
            FinalUri = $response.RequestMessage.RequestUri
            StatusCode = $statusCode
        }
    } finally {
        if ($null -ne $response) {
            $response.Dispose()
        }
        $request.Dispose()
    }
}

function Invoke-StablePublicJsonRequest {
    param(
        [Net.Http.HttpClient]$Client,
        [string]$Uri,
        [ValidateRange(2, 5)]
        [int]$Attempts
    )

    $result = $null
    for ($attempt = 1; $attempt -le $Attempts; $attempt += 1) {
        try {
            $result = Invoke-JsonRequest -Client $Client -Uri $Uri
        } catch {
            throw "Public endpoint failed stability sample $attempt of ${Attempts}: $(Get-SafeErrorMessage $_.Exception)"
        }
    }
    return $result
}

function Invoke-AuthenticatedMediaProbe {
    param(
        [Net.Http.HttpClient]$Client,
        [string]$Homeserver,
        [string]$MxcUri,
        [string]$AccessToken,
        [int]$MaximumBytes
    )

    $match = [regex]::Match(
        $MxcUri,
        '^mxc://(?<server>[A-Za-z0-9.:-]+)/(?<media>[A-Za-z0-9_-]+)$'
    )
    Assert-Check $match.Success "MESH_SMOKE_MEDIA_MXC must be a simple mxc:// URI."

    $server = [Uri]::EscapeDataString($match.Groups["server"].Value)
    $media = [Uri]::EscapeDataString($match.Groups["media"].Value)
    $uri = "$($Homeserver.TrimEnd('/'))/_matrix/client/v1/media/download/$server/$media"
    $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, $uri)
    $request.Headers.Authorization =
        [Net.Http.Headers.AuthenticationHeaderValue]::new("Bearer", $AccessToken)

    $response = $null
    $stream = $null
    try {
        $response = $Client.SendAsync(
            $request,
            [Net.Http.HttpCompletionOption]::ResponseHeadersRead
        ).GetAwaiter().GetResult()
        Assert-Check $response.IsSuccessStatusCode `
            "Authenticated media download returned HTTP $([int]$response.StatusCode)."
        $contentLength = $response.Content.Headers.ContentLength
        if ($null -ne $contentLength) {
            Assert-Check ([long]$contentLength -le $MaximumBytes) `
                "Configured smoke media exceeds the $MaximumBytes-byte limit."
        }

        $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $buffer = [byte[]]::new(8192)
        $received = 0
        while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $received += $read
            Assert-Check ($received -le $MaximumBytes) `
                "Configured smoke media exceeded the $MaximumBytes-byte limit while downloading."
        }
        Assert-Check ($received -gt 0) "Configured smoke media returned an empty body."
    } finally {
        if ($null -ne $stream) {
            $stream.Dispose()
        }
        if ($null -ne $response) {
            $response.Dispose()
        }
        $request.Dispose()
    }
}

function Test-StatusEndpoint {
    param(
        [Net.Http.HttpClient]$Client,
        [string]$Uri,
        [string]$BearerToken,
        [switch]$RequireFreshBackup,
        [int]$MaximumAgeMinutes
    )

    $result = Invoke-JsonRequest `
        -Client $Client `
        -Uri $Uri `
        -BearerToken $BearerToken
    $status = [string](Get-PropertyValue $result.Json "status")
    Assert-Check ($status -in @("ok", "healthy", "success", "up")) `
        "Status endpoint must report ok, healthy, success, or up."

    if ($RequireFreshBackup) {
        $timestampText = [string](Get-PropertyValue $result.Json "lastSuccessfulAt")
        $timestamp = [DateTimeOffset]::MinValue
        Assert-Check ([DateTimeOffset]::TryParse(
            $timestampText,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::AssumeUniversal,
            [ref]$timestamp
        )) "Backup status is missing a valid lastSuccessfulAt timestamp."
        $age = [DateTimeOffset]::UtcNow - $timestamp.ToUniversalTime()
        Assert-Check ($age.TotalMinutes -ge 0) `
            "Backup status timestamp is in the future."
        Assert-Check ($age.TotalMinutes -le $MaximumAgeMinutes) `
            "Latest successful backup is $([Math]::Round($age.TotalMinutes)) minutes old; maximum is $MaximumAgeMinutes."
    }
}

function Assert-ReviewedServerIdentity {
    param(
        [string]$ActualSoftware,
        [string]$ActualVersion,
        [string]$ExpectedSoftware,
        [string]$ExpectedVersion
    )

    Assert-Check ($ActualSoftware -ceq $ExpectedSoftware) `
        "Federation endpoint is running unexpected server software."
    Assert-Check ($ActualVersion -ceq $ExpectedVersion) `
        "Federation endpoint version does not match the reviewed deployment."
}

function Get-ReviewedSynapseVersion {
    $policyPath = Join-Path $repoRoot "infra/container-security-policy.json"
    Assert-Check (Test-Path -LiteralPath $policyPath -PathType Leaf) `
        "Container security policy is missing."
    try {
        $policy = Get-Content -LiteralPath $policyPath -Raw | ConvertFrom-Json
    } catch {
        throw "Container security policy could not be parsed."
    }
    $synapse = @($policy.images | Where-Object {
        $_.name -ceq "synapse" -and $_.milestone -ceq "R2"
    })
    Assert-Check ($synapse.Count -eq 1) `
        "Container security policy must contain exactly one R2 Synapse image."
    $match = [regex]::Match(
        [string]$synapse[0].image,
        '^matrixdotorg/synapse:v(?<version>[0-9A-Za-z.+_-]+)@sha256:[0-9a-f]{64}$'
    )
    Assert-Check $match.Success `
        "Container security policy contains an invalid Synapse image pin."
    return $match.Groups["version"].Value
}

$config = Read-PublicEnvironmentFile $EnvironmentFile
$requiredNames = @(
    "MESH_SMOKE_MATRIX_SERVER_NAME",
    "MESH_SMOKE_HOMESERVER_URL",
    "MESH_SMOKE_EXPECTED_SERVER_SOFTWARE",
    "MESH_SMOKE_EXPECTED_SERVER_VERSION",
    "MESH_SMOKE_EXPECTED_USER_ID",
    "MESH_SMOKE_MAS_ISSUER",
    "MESH_SMOKE_MAS_METADATA_URL",
    "MESH_SMOKE_ENCRYPTED_ROOM_ID",
    "MESH_SMOKE_MEDIA_MXC",
    "MESH_SMOKE_MEDIA_MAX_BYTES",
    "MESH_SMOKE_BACKUP_STATUS_URL",
    "MESH_SMOKE_BACKUP_MAX_AGE_MINUTES",
    "MESH_SMOKE_MONITORING_HEALTH_URL"
)
$voiceAcceptance = $Milestone -eq "R3"
if ($voiceAcceptance) {
    $requiredNames += @(
        "MESH_SMOKE_MATRIXRTC_SERVICE_URL",
        "MESH_SMOKE_SFU_URL",
        "MESH_SMOKE_TURN_URL",
        "MESH_SMOKE_TURN_TLS_URL"
    )
}
$values = @{}
foreach ($name in $requiredNames) {
    $values[$name] = Get-RequiredConfig $config $name
}

$serverName = [string]$values["MESH_SMOKE_MATRIX_SERVER_NAME"]
if ($serverName -and
    $serverName -notmatch '^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$') {
    Add-Failure "MESH_SMOKE_MATRIX_SERVER_NAME must be a Matrix server name, not a URL."
}
$expectedServerSoftware = [string]$values["MESH_SMOKE_EXPECTED_SERVER_SOFTWARE"]
if ($expectedServerSoftware -and
    $expectedServerSoftware -notmatch '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$') {
    Add-Failure "MESH_SMOKE_EXPECTED_SERVER_SOFTWARE must be a bounded software name."
}
$expectedServerVersion = [string]$values["MESH_SMOKE_EXPECTED_SERVER_VERSION"]
if ($expectedServerVersion -and
    $expectedServerVersion -notmatch '^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$') {
    Add-Failure "MESH_SMOKE_EXPECTED_SERVER_VERSION must be a bounded version identifier."
}
$reviewedSynapseVersion = Get-ReviewedSynapseVersion
if ($expectedServerSoftware -cne "Synapse" -or
    $expectedServerVersion -cne $reviewedSynapseVersion) {
    Add-Failure "Operator smoke server identity must match the exact R2 Synapse deployment pin."
}

Test-ServiceUri "MESH_SMOKE_HOMESERVER_URL" `
    $values["MESH_SMOKE_HOMESERVER_URL"] @("https")
Test-ServiceUri "MESH_SMOKE_MAS_ISSUER" `
    $values["MESH_SMOKE_MAS_ISSUER"] @("https") -AllowPath
Test-ServiceUri "MESH_SMOKE_MAS_METADATA_URL" `
    $values["MESH_SMOKE_MAS_METADATA_URL"] @("https") -AllowPath
if ($voiceAcceptance) {
    Test-ServiceUri "MESH_SMOKE_MATRIXRTC_SERVICE_URL" `
        $values["MESH_SMOKE_MATRIXRTC_SERVICE_URL"] @("https") -AllowPath
    Test-ServiceUri "MESH_SMOKE_SFU_URL" `
        $values["MESH_SMOKE_SFU_URL"] @("wss") -AllowPath
}
Test-ServiceUri "MESH_SMOKE_BACKUP_STATUS_URL" `
    $values["MESH_SMOKE_BACKUP_STATUS_URL"] @("https") -AllowPath
Test-ServiceUri "MESH_SMOKE_MONITORING_HEALTH_URL" `
    $values["MESH_SMOKE_MONITORING_HEALTH_URL"] @("https") -AllowPath
if ($voiceAcceptance) {
    $turnUdpEndpoint = Get-IceEndpoint `
        "MESH_SMOKE_TURN_URL" $values["MESH_SMOKE_TURN_URL"] "turn"
    $turnTlsEndpoint = Get-IceEndpoint `
        "MESH_SMOKE_TURN_TLS_URL" $values["MESH_SMOKE_TURN_TLS_URL"] "turns"
    if ($null -ne $turnUdpEndpoint -and
        $turnUdpEndpoint.Transport -and $turnUdpEndpoint.Transport -ne "udp") {
        Add-Failure "MESH_SMOKE_TURN_URL must use UDP for the authenticated Allocate proof."
    }
    if ($null -ne $turnTlsEndpoint -and
        $turnTlsEndpoint.Transport -and $turnTlsEndpoint.Transport -ne "tcp") {
        Add-Failure "MESH_SMOKE_TURN_TLS_URL must use TCP."
    }
}

$mediaMaxBytes = 0
if (-not [int]::TryParse(
    $values["MESH_SMOKE_MEDIA_MAX_BYTES"],
    [ref]$mediaMaxBytes
) -or $mediaMaxBytes -lt 1 -or $mediaMaxBytes -gt 10485760) {
    Add-Failure "MESH_SMOKE_MEDIA_MAX_BYTES must be between 1 and 10485760."
}

$backupMaxAgeMinutes = 0
if (-not [int]::TryParse(
    $values["MESH_SMOKE_BACKUP_MAX_AGE_MINUTES"],
    [ref]$backupMaxAgeMinutes
) -or $backupMaxAgeMinutes -lt 1 -or $backupMaxAgeMinutes -gt 10080) {
    Add-Failure "MESH_SMOKE_BACKUP_MAX_AGE_MINUTES must be between 1 and 10080."
}

if ($values["MESH_SMOKE_EXPECTED_USER_ID"] -and
    $values["MESH_SMOKE_EXPECTED_USER_ID"] -notmatch '^@[^:]+:.+$') {
    Add-Failure "MESH_SMOKE_EXPECTED_USER_ID must be a full Matrix user ID."
}
if ($values["MESH_SMOKE_ENCRYPTED_ROOM_ID"] -and
    $values["MESH_SMOKE_ENCRYPTED_ROOM_ID"] -notmatch '^![^:]+:.+$') {
    Add-Failure "MESH_SMOKE_ENCRYPTED_ROOM_ID must be a full Matrix room ID."
}
if ($values["MESH_SMOKE_MEDIA_MXC"] -and
    $values["MESH_SMOKE_MEDIA_MXC"] -notmatch '^mxc://') {
    Add-Failure "MESH_SMOKE_MEDIA_MXC must use the mxc:// scheme."
}

if ($Production) {
    foreach ($entry in $config.GetEnumerator()) {
        if ($entry.Value -match '(?i)(example\.com|replace|localhost|changeme|<.+>)') {
            Add-Failure "Production configuration $($entry.Key) still contains a placeholder."
        }
    }
}
if ($Online -and -not $Production) {
    Add-Failure "-Online requires -Production so tracked example endpoints cannot be probed accidentally."
}

Add-Pass "Public configuration parsed with secret-like keys excluded."

if (-not $Online) {
    $offlineScope = if ($voiceAcceptance) {
        "DNS, TLS, account, encrypted sync, media, MatrixRTC, SFU, TURN, backup, or monitoring"
    } else {
        "DNS, TLS, account, encrypted sync, media, backup, or monitoring"
    }
    Add-Warning "Offline mode only: no $offlineScope evidence was collected."
} elseif ($failures.Count -eq 0) {
    $publicServiceHosts = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )
    [void]$publicServiceHosts.Add(($serverName -split ':', 2)[0])
    foreach ($uriSetting in @(
        "MESH_SMOKE_HOMESERVER_URL",
        "MESH_SMOKE_MAS_ISSUER",
        "MESH_SMOKE_MAS_METADATA_URL"
    )) {
        [void]$publicServiceHosts.Add(([Uri]$values[$uriSetting]).DnsSafeHost)
    }
    if ($voiceAcceptance) {
        foreach ($uriSetting in @(
            "MESH_SMOKE_MATRIXRTC_SERVICE_URL",
            "MESH_SMOKE_SFU_URL"
        )) {
            [void]$publicServiceHosts.Add(([Uri]$values[$uriSetting]).DnsSafeHost)
        }
        [void]$publicServiceHosts.Add($turnUdpEndpoint.Host)
        [void]$publicServiceHosts.Add($turnTlsEndpoint.Host)
    }
    foreach ($publicServiceHost in $publicServiceHosts) {
        Assert-PublicDnsResolution $publicServiceHost
    }

    $client = New-SmokeHttpClient
    try {
        $homeserver = [string]$values["MESH_SMOKE_HOMESERVER_URL"]
        $expectedIssuer = [string]$values["MESH_SMOKE_MAS_ISSUER"]
        $rtcService = if ($voiceAcceptance) { [string]$values["MESH_SMOKE_MATRIXRTC_SERVICE_URL"] } else { "" }
        $expectedSfu = if ($voiceAcceptance) { [Uri]$values["MESH_SMOKE_SFU_URL"] } else { $null }
        $roomId = [string]$values["MESH_SMOKE_ENCRYPTED_ROOM_ID"]
        $expectedUserId = [string]$values["MESH_SMOKE_EXPECTED_USER_ID"]

        Invoke-LiveCheck "Homeserver client discovery and versions" {
            $wellKnown = Invoke-StablePublicJsonRequest `
                -Client $client `
                -Uri "https://$serverName/.well-known/matrix/client" `
                -Attempts $PublicProbeAttempts
            $homeserverObject = Get-PropertyValue $wellKnown.Json "m.homeserver"
            $discoveredBase = [string](Get-PropertyValue $homeserverObject "base_url")
            Assert-Check ($discoveredBase.TrimEnd("/") -eq $homeserver.TrimEnd("/")) `
                "Discovered homeserver does not match MESH_SMOKE_HOMESERVER_URL."
            $versions = Invoke-StablePublicJsonRequest `
                -Client $client `
                -Uri "$($homeserver.TrimEnd('/'))/_matrix/client/versions" `
                -Attempts $PublicProbeAttempts
            Assert-Check (@(Get-PropertyValue $versions.Json "versions").Count -gt 0) `
                "Homeserver returned no Matrix client API versions."

            if ($voiceAcceptance) {
                $focusProperty = Get-PropertyValue `
                    $wellKnown.Json `
                    "org.matrix.msc4143.rtc_foci"
                $liveKitFocus = @($focusProperty | Where-Object {
                    $_.type -eq "livekit" -and
                    $_.livekit_service_url.TrimEnd("/") -eq $rtcService.TrimEnd("/")
                })
                Assert-Check ($liveKitFocus.Count -gt 0) `
                    "Client discovery does not advertise the expected MatrixRTC service."
            }

            $authentication = Get-PropertyValue `
                $wellKnown.Json `
                "org.matrix.msc2965.authentication"
            $discoveredIssuer = [string](Get-PropertyValue $authentication "issuer")
            Assert-Check ($discoveredIssuer.TrimEnd("/") -eq $expectedIssuer.TrimEnd("/")) `
                "Client discovery does not advertise the expected MAS issuer."
        }

        Invoke-LiveCheck "Federation discovery and version endpoint" {
            $federationWellKnown = Invoke-StablePublicJsonRequest `
                -Client $client `
                -Uri "https://$serverName/.well-known/matrix/server" `
                -Attempts $PublicProbeAttempts
            $authority = [string](Get-PropertyValue $federationWellKnown.Json "m.server")
            Assert-Check ($authority -match '^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$') `
                "Federation discovery returned an invalid m.server authority."
            $federationVersion = Invoke-StablePublicJsonRequest `
                -Client $client `
                -Uri "https://$authority/_matrix/federation/v1/version" `
                -Attempts $PublicProbeAttempts
            $server = Get-PropertyValue $federationVersion.Json "server"
            Assert-Check ($null -ne $server) `
                "Federation version response is missing server metadata."
            $actualServerSoftware = [string](Get-PropertyValue $server "name")
            $actualServerVersion = [string](Get-PropertyValue $server "version")
            Assert-ReviewedServerIdentity `
                -ActualSoftware $actualServerSoftware `
                -ActualVersion $actualServerVersion `
                -ExpectedSoftware $expectedServerSoftware `
                -ExpectedVersion $expectedServerVersion
        }

        Invoke-LiveCheck "MAS/OIDC discovery, grants, and S256 PKCE" {
            $metadata = Invoke-StablePublicJsonRequest `
                -Client $client `
                -Uri $values["MESH_SMOKE_MAS_METADATA_URL"] `
                -Attempts $PublicProbeAttempts
            $issuer = [string](Get-PropertyValue $metadata.Json "issuer")
            Assert-Check ($issuer.TrimEnd("/") -eq $expectedIssuer.TrimEnd("/")) `
                "OIDC metadata issuer does not match MESH_SMOKE_MAS_ISSUER."
            foreach ($endpointName in @(
                "authorization_endpoint",
                "token_endpoint",
                "jwks_uri"
            )) {
                $endpoint = [string](Get-PropertyValue $metadata.Json $endpointName)
                $endpointUri = $null
                Assert-Check ([Uri]::TryCreate(
                    $endpoint,
                    [UriKind]::Absolute,
                    [ref]$endpointUri
                ) -and $endpointUri.Scheme -eq "https" -and -not $endpointUri.UserInfo) `
                    "OIDC $endpointName must be an absolute credential-free HTTPS URI."
            }
            Assert-Check ("code" -in @(Get-PropertyValue $metadata.Json "response_types_supported")) `
                "OIDC metadata does not advertise the code response type."
            $grants = @(Get-PropertyValue $metadata.Json "grant_types_supported")
            Assert-Check ("authorization_code" -in $grants -and "refresh_token" -in $grants) `
                "OIDC metadata must advertise authorization_code and refresh_token grants."
            Assert-Check ("S256" -in @(Get-PropertyValue $metadata.Json "code_challenge_methods_supported")) `
                "OIDC metadata does not advertise S256 PKCE."
        }

        if ($voiceAcceptance) {
            Invoke-LiveCheck "MatrixRTC authorization-service health" {
                $health = Invoke-StablePublicJsonRequest `
                    -Client $client `
                    -Uri "$($rtcService.TrimEnd('/'))/healthz" `
                    -Attempts $PublicProbeAttempts
                $healthStatus = Get-PropertyValue $health.Json "status"
                if ($null -ne $healthStatus) {
                    Assert-Check ([string]$healthStatus -in @("ok", "healthy", "up")) `
                        "Authorization service health JSON is not healthy."
                }
            }
        }

        $matrixAccessToken = Get-ProcessSecret "MESH_SMOKE_MATRIX_ACCESS_TOKEN"
        $turnUsername = if ($voiceAcceptance) { Get-ProcessSecret "MESH_SMOKE_TURN_USERNAME" } else { "" }
        $turnPassword = if ($voiceAcceptance) { Get-ProcessSecret "MESH_SMOKE_TURN_PASSWORD" } else { "" }
        $backupBearer = Get-ProcessSecret "MESH_SMOKE_BACKUP_BEARER_TOKEN"
        $monitoringBearer = Get-ProcessSecret "MESH_SMOKE_MONITORING_BEARER_TOKEN"

        $whoAmI = $null
        if ([string]::IsNullOrWhiteSpace($matrixAccessToken)) {
            $accountScope = if ($voiceAcceptance) { "Account authentication, encrypted sync, Matrix media, and MatrixRTC authorization" } else { "Account authentication, encrypted sync, and Matrix media" }
            Add-Failure "$accountScope are blocked: inject MESH_SMOKE_MATRIX_ACCESS_TOKEN through the process environment."
        } else {
            Invoke-LiveCheck "Account authentication through Matrix whoami" {
                $script:whoAmI = (Invoke-JsonRequest `
                    -Client $client `
                    -Uri "$($homeserver.TrimEnd('/'))/_matrix/client/v3/account/whoami" `
                    -BearerToken $matrixAccessToken).Json
                $actualUserId = [string](Get-PropertyValue $script:whoAmI "user_id")
                Assert-Check ($actualUserId -eq $expectedUserId) `
                    "Access token belongs to an unexpected Matrix user."
                Assert-Check (-not [string]::IsNullOrWhiteSpace(
                    [string](Get-PropertyValue $script:whoAmI "device_id")
                )) "whoami did not return a device_id."
            }

            Invoke-LiveCheck "Encrypted room membership, state, and encrypted history sync" {
                $encodedRoom = [Uri]::EscapeDataString($roomId)
                $encryption = Invoke-JsonRequest `
                    -Client $client `
                    -Uri "$($homeserver.TrimEnd('/'))/_matrix/client/v3/rooms/$encodedRoom/state/m.room.encryption" `
                    -BearerToken $matrixAccessToken
                Assert-Check (
                    (Get-PropertyValue $encryption.Json "algorithm") -eq
                    "m.megolm.v1.aes-sha2"
                ) "Room does not use the expected Matrix Megolm encryption algorithm."

                $filter = @{
                    room = @{
                        rooms = @($roomId)
                        timeline = @{ limit = 10 }
                    }
                } | ConvertTo-Json -Depth 5 -Compress
                $encodedFilter = [Uri]::EscapeDataString($filter)
                $sync = Invoke-JsonRequest `
                    -Client $client `
                    -Uri "$($homeserver.TrimEnd('/'))/_matrix/client/v3/sync?timeout=0&filter=$encodedFilter" `
                    -BearerToken $matrixAccessToken
                $rooms = Get-PropertyValue $sync.Json "rooms"
                $joined = Get-PropertyValue $rooms "join"
                Assert-Check ($null -ne $joined.PSObject.Properties[$roomId]) `
                    "Configured encrypted room was not present in joined-room sync."

                $messages = Invoke-JsonRequest `
                    -Client $client `
                    -Uri "$($homeserver.TrimEnd('/'))/_matrix/client/v3/rooms/$encodedRoom/messages?dir=b&limit=50" `
                    -BearerToken $matrixAccessToken
                $encryptedEvents = @(
                    (Get-PropertyValue $messages.Json "chunk") |
                        Where-Object { $_.type -eq "m.room.encrypted" }
                )
                Assert-Check ($encryptedEvents.Count -gt 0) `
                    "No m.room.encrypted event was found in the latest 50 room events."
            }

            Invoke-LiveCheck "Authenticated Matrix media configuration and download" {
                $mediaConfig = Invoke-JsonRequest `
                    -Client $client `
                    -Uri "$($homeserver.TrimEnd('/'))/_matrix/client/v1/media/config" `
                    -BearerToken $matrixAccessToken
                $uploadLimit = Get-PropertyValue $mediaConfig.Json "m.upload.size"
                if ($null -ne $uploadLimit) {
                    Assert-Check ([long]$uploadLimit -gt 0) `
                        "Homeserver reported a non-positive media upload limit."
                }
                Invoke-AuthenticatedMediaProbe `
                    -Client $client `
                    -Homeserver $homeserver `
                    -MxcUri $values["MESH_SMOKE_MEDIA_MXC"] `
                    -AccessToken $matrixAccessToken `
                    -MaximumBytes $mediaMaxBytes
            }

            if ($voiceAcceptance -and $null -eq $whoAmI) {
                Add-Failure "MatrixRTC authenticated token exchange is blocked because whoami did not pass."
            } elseif ($voiceAcceptance) {
                Invoke-LiveCheck "Matrix OpenID to MatrixRTC JWT exchange and SFU WebSocket" {
                    $actualUserId = [string](Get-PropertyValue $whoAmI "user_id")
                    $deviceId = [string](Get-PropertyValue $whoAmI "device_id")
                    $encodedUser = [Uri]::EscapeDataString($actualUserId)
                    $openid = (Invoke-JsonRequest `
                        -Client $client `
                        -Uri "$($homeserver.TrimEnd('/'))/_matrix/client/v3/user/$encodedUser/openid/request_token" `
                        -Method "POST" `
                        -BearerToken $matrixAccessToken `
                        -Body @{}).Json
                    $openidAccessToken = [string](Get-PropertyValue $openid "access_token")
                    Assert-Check (-not [string]::IsNullOrWhiteSpace($openidAccessToken)) `
                        "Homeserver did not return a Matrix OpenID token."
                    $sensitiveValues.Add($openidAccessToken)

                    $tokenRequest = @{
                        room_id = $roomId
                        slot_id = "mesh-operator-smoke-$([Guid]::NewGuid().ToString('N'))"
                        openid_token = @{
                            access_token = $openidAccessToken
                            token_type = Get-PropertyValue $openid "token_type"
                            matrix_server_name = Get-PropertyValue $openid "matrix_server_name"
                            expires_in = Get-PropertyValue $openid "expires_in"
                        }
                        member = @{
                            id = [Guid]::NewGuid().ToString()
                            claimed_user_id = $actualUserId
                            claimed_device_id = $deviceId
                        }
                    }
                    $rtc = (Invoke-JsonRequest `
                        -Client $client `
                        -Uri "$($rtcService.TrimEnd('/'))/get_token" `
                        -Method "POST" `
                        -Body $tokenRequest).Json
                    $rtcUrl = [Uri](Get-PropertyValue $rtc "url")
                    $jwt = [string](Get-PropertyValue $rtc "jwt")
                    Assert-Check (-not [string]::IsNullOrWhiteSpace($jwt)) `
                        "MatrixRTC Authorization Service returned no JWT."
                    $sensitiveValues.Add($jwt)
                    Assert-Check (
                        $rtcUrl.Scheme -eq $expectedSfu.Scheme -and
                        $rtcUrl.Host -eq $expectedSfu.Host -and
                        $rtcUrl.Port -eq $expectedSfu.Port -and
                        $rtcUrl.AbsolutePath.TrimEnd("/") -eq
                            $expectedSfu.AbsolutePath.TrimEnd("/")
                    ) "MatrixRTC Authorization Service returned an unexpected SFU URL."

                    $builder = [UriBuilder]::new($rtcUrl)
                    $builder.Path = "$($builder.Path.TrimEnd('/'))/rtc"
                    $builder.Query = "access_token=$([Uri]::EscapeDataString($jwt))&auto_subscribe=0"
                    $webSocket = [Net.WebSockets.ClientWebSocket]::new()
                    $cancellation = [Threading.CancellationTokenSource]::new(
                        [TimeSpan]::FromSeconds($TimeoutSeconds)
                    )
                    try {
                        try {
                            $webSocket.ConnectAsync(
                                $builder.Uri,
                                $cancellation.Token
                            ).GetAwaiter().GetResult()
                        } catch {
                            throw "Authenticated SFU WebSocket handshake did not complete."
                        }
                        Assert-Check (
                            $webSocket.State -eq [Net.WebSockets.WebSocketState]::Open
                        ) "Authenticated SFU WebSocket did not reach the open state."
                        $webSocket.Abort()
                    } finally {
                        $cancellation.Dispose()
                        $webSocket.Dispose()
                        $jwt = $null
                        $openidAccessToken = $null
                    }
                }
            }
        }

        if ($voiceAcceptance) {
            if ([string]::IsNullOrWhiteSpace($turnUsername) -or
                [string]::IsNullOrWhiteSpace($turnPassword)) {
                Add-Failure "TURN allocation is blocked: inject MESH_SMOKE_TURN_USERNAME and MESH_SMOKE_TURN_PASSWORD through the process environment."
            } else {
                Invoke-LiveCheck "Authenticated TURN allocation" {
                $probePath = Join-Path $scriptRoot "probe-turn.ps1"
                Assert-Check (Test-Path -LiteralPath $probePath -PathType Leaf) `
                    "TURN probe script is missing."
                $powershellPath = (Get-Process -Id $PID).Path
                $oldUrl = [Environment]::GetEnvironmentVariable("MESH_TURN_URL")
                $oldUsername = [Environment]::GetEnvironmentVariable("MESH_TURN_USERNAME")
                $oldPassword = [Environment]::GetEnvironmentVariable("MESH_TURN_PASSWORD")
                $oldExpect = [Environment]::GetEnvironmentVariable("MESH_TURN_EXPECT")
                try {
                    $env:MESH_TURN_URL = $values["MESH_SMOKE_TURN_URL"]
                    $env:MESH_TURN_USERNAME = $turnUsername
                    $env:MESH_TURN_PASSWORD = $turnPassword
                    $env:MESH_TURN_EXPECT = "allocation_ok"
                    & $powershellPath `
                        -NoProfile `
                        -ExecutionPolicy Bypass `
                        -File $probePath *> $null
                    Assert-Check ($LASTEXITCODE -eq 0) `
                        "TURN Allocate probe did not report allocation_ok."
                } finally {
                    $env:MESH_TURN_URL = $oldUrl
                    $env:MESH_TURN_USERNAME = $oldUsername
                    $env:MESH_TURN_PASSWORD = $oldPassword
                    $env:MESH_TURN_EXPECT = $oldExpect
                }
                }
            }

            Invoke-LiveCheck "TURN/TLS trusted transport reachability (not allocation)" {
                Test-TurnTlsTransport `
                    -Url $values["MESH_SMOKE_TURN_TLS_URL"] `
                    -TimeoutMilliseconds ($TimeoutSeconds * 1000)
            }
            Add-Warning "TURN/TLS handshake success does not prove Allocate or relayed media. A real Mesh call forced to a relay candidate over TURN/TLS remains a release gate."
        }

        Invoke-LiveCheck "Backup freshness" {
            Test-StatusEndpoint `
                -Client $client `
                -Uri $values["MESH_SMOKE_BACKUP_STATUS_URL"] `
                -BearerToken $backupBearer `
                -RequireFreshBackup `
                -MaximumAgeMinutes $backupMaxAgeMinutes
        }

        Invoke-LiveCheck "Monitoring health" {
            Test-StatusEndpoint `
                -Client $client `
                -Uri $values["MESH_SMOKE_MONITORING_HEALTH_URL"] `
                -BearerToken $monitoringBearer
        }
    } finally {
        $client.Dispose()
    }
}

Write-Host ""
Write-Host "Mesh production operator smoke"
Write-Host "Mode: $(if ($Online) { 'production live' } else { 'static/offline' }); milestone: $Milestone"
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
    Write-Host "Operator smoke failed with $($failures.Count) blocker(s)." -ForegroundColor Red
    exit 1
}

Write-Host ""
if ($Online) {
    Write-Host "Configured production service checks passed. This does not prove client-side message/media decryption, backup restore, MatrixRTC media E2EE, HA, or public-network abuse readiness." -ForegroundColor Green
} else {
    Write-Host "Static operator-smoke configuration passed. Run with -Production -Online and process-injected credentials to collect live evidence." -ForegroundColor Green
}
