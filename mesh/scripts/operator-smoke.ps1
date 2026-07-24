[CmdletBinding()]
param(
    [switch]$Production,
    [switch]$Online,
    [string]$EnvironmentFile = "",
    [ValidateRange(3, 60)]
    [int]$TimeoutSeconds = 15
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
        $response = $Client.SendAsync($request).GetAwaiter().GetResult()
        $statusCode = [int]$response.StatusCode
        Assert-Check ($response.IsSuccessStatusCode) "HTTP $statusCode."
        Assert-Check ($response.RequestMessage.RequestUri.Scheme -eq "https") `
            "Redirected response left HTTPS."

        $bytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
        Assert-Check ($bytes.Length -le $MaximumBytes) `
            "Response exceeded the $MaximumBytes-byte limit."
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
        if ($response.Content.Headers.ContentLength.HasValue) {
            Assert-Check ($response.Content.Headers.ContentLength.Value -le $MaximumBytes) `
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

$config = Read-PublicEnvironmentFile $EnvironmentFile
$requiredNames = @(
    "MESH_SMOKE_MATRIX_SERVER_NAME",
    "MESH_SMOKE_HOMESERVER_URL",
    "MESH_SMOKE_EXPECTED_USER_ID",
    "MESH_SMOKE_MAS_ISSUER",
    "MESH_SMOKE_MAS_METADATA_URL",
    "MESH_SMOKE_ENCRYPTED_ROOM_ID",
    "MESH_SMOKE_MEDIA_MXC",
    "MESH_SMOKE_MEDIA_MAX_BYTES",
    "MESH_SMOKE_MATRIXRTC_SERVICE_URL",
    "MESH_SMOKE_SFU_URL",
    "MESH_SMOKE_TURN_URL",
    "MESH_SMOKE_BACKUP_STATUS_URL",
    "MESH_SMOKE_BACKUP_MAX_AGE_MINUTES",
    "MESH_SMOKE_MONITORING_HEALTH_URL"
)
$values = @{}
foreach ($name in $requiredNames) {
    $values[$name] = Get-RequiredConfig $config $name
}

$serverName = [string]$values["MESH_SMOKE_MATRIX_SERVER_NAME"]
if ($serverName -and
    $serverName -notmatch '^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$') {
    Add-Failure "MESH_SMOKE_MATRIX_SERVER_NAME must be a Matrix server name, not a URL."
}

Test-ServiceUri "MESH_SMOKE_HOMESERVER_URL" `
    $values["MESH_SMOKE_HOMESERVER_URL"] @("https")
Test-ServiceUri "MESH_SMOKE_MAS_ISSUER" `
    $values["MESH_SMOKE_MAS_ISSUER"] @("https") -AllowPath
Test-ServiceUri "MESH_SMOKE_MAS_METADATA_URL" `
    $values["MESH_SMOKE_MAS_METADATA_URL"] @("https") -AllowPath
Test-ServiceUri "MESH_SMOKE_MATRIXRTC_SERVICE_URL" `
    $values["MESH_SMOKE_MATRIXRTC_SERVICE_URL"] @("https") -AllowPath
Test-ServiceUri "MESH_SMOKE_SFU_URL" `
    $values["MESH_SMOKE_SFU_URL"] @("wss") -AllowPath
Test-ServiceUri "MESH_SMOKE_BACKUP_STATUS_URL" `
    $values["MESH_SMOKE_BACKUP_STATUS_URL"] @("https") -AllowPath
Test-ServiceUri "MESH_SMOKE_MONITORING_HEALTH_URL" `
    $values["MESH_SMOKE_MONITORING_HEALTH_URL"] @("https") -AllowPath
Test-ServiceUri "MESH_SMOKE_TURN_URL" `
    $values["MESH_SMOKE_TURN_URL"] @("turn", "turns") -AllowQuery -AllowPath

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
    Add-Warning "Offline mode only: no DNS, TLS, account, encrypted sync, media, MatrixRTC, SFU, TURN, backup, or monitoring evidence was collected."
} elseif ($failures.Count -eq 0) {
    $client = New-SmokeHttpClient
    try {
        $homeserver = [string]$values["MESH_SMOKE_HOMESERVER_URL"]
        $expectedIssuer = [string]$values["MESH_SMOKE_MAS_ISSUER"]
        $rtcService = [string]$values["MESH_SMOKE_MATRIXRTC_SERVICE_URL"]
        $expectedSfu = [Uri]$values["MESH_SMOKE_SFU_URL"]
        $roomId = [string]$values["MESH_SMOKE_ENCRYPTED_ROOM_ID"]
        $expectedUserId = [string]$values["MESH_SMOKE_EXPECTED_USER_ID"]

        Invoke-LiveCheck "Homeserver client discovery and versions" {
            $wellKnown = Invoke-JsonRequest `
                -Client $client `
                -Uri "https://$serverName/.well-known/matrix/client"
            $homeserverObject = Get-PropertyValue $wellKnown.Json "m.homeserver"
            $discoveredBase = [string](Get-PropertyValue $homeserverObject "base_url")
            Assert-Check ($discoveredBase.TrimEnd("/") -eq $homeserver.TrimEnd("/")) `
                "Discovered homeserver does not match MESH_SMOKE_HOMESERVER_URL."
            $versions = Invoke-JsonRequest `
                -Client $client `
                -Uri "$($homeserver.TrimEnd('/'))/_matrix/client/versions"
            Assert-Check (@(Get-PropertyValue $versions.Json "versions").Count -gt 0) `
                "Homeserver returned no Matrix client API versions."

            $focusProperty = Get-PropertyValue `
                $wellKnown.Json `
                "org.matrix.msc4143.rtc_foci"
            $liveKitFocus = @($focusProperty | Where-Object {
                $_.type -eq "livekit" -and
                $_.livekit_service_url.TrimEnd("/") -eq $rtcService.TrimEnd("/")
            })
            Assert-Check ($liveKitFocus.Count -gt 0) `
                "Client discovery does not advertise the expected MatrixRTC service."

            $authentication = Get-PropertyValue `
                $wellKnown.Json `
                "org.matrix.msc2965.authentication"
            $discoveredIssuer = [string](Get-PropertyValue $authentication "issuer")
            Assert-Check ($discoveredIssuer.TrimEnd("/") -eq $expectedIssuer.TrimEnd("/")) `
                "Client discovery does not advertise the expected MAS issuer."
        }

        Invoke-LiveCheck "Federation discovery and version endpoint" {
            $federationWellKnown = Invoke-JsonRequest `
                -Client $client `
                -Uri "https://$serverName/.well-known/matrix/server"
            $authority = [string](Get-PropertyValue $federationWellKnown.Json "m.server")
            Assert-Check ($authority -match '^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$') `
                "Federation discovery returned an invalid m.server authority."
            $federationVersion = Invoke-JsonRequest `
                -Client $client `
                -Uri "https://$authority/_matrix/federation/v1/version"
            $server = Get-PropertyValue $federationVersion.Json "server"
            Assert-Check ($null -ne $server) `
                "Federation version response is missing server metadata."
        }

        Invoke-LiveCheck "MAS/OIDC discovery, grants, and S256 PKCE" {
            $metadata = Invoke-JsonRequest `
                -Client $client `
                -Uri $values["MESH_SMOKE_MAS_METADATA_URL"]
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

        Invoke-LiveCheck "MatrixRTC authorization-service health" {
            $health = Invoke-JsonRequest `
                -Client $client `
                -Uri "$($rtcService.TrimEnd('/'))/healthz"
            $healthStatus = Get-PropertyValue $health.Json "status"
            if ($null -ne $healthStatus) {
                Assert-Check ([string]$healthStatus -in @("ok", "healthy", "up")) `
                    "Authorization service health JSON is not healthy."
            }
        }

        $matrixAccessToken = Get-ProcessSecret "MESH_SMOKE_MATRIX_ACCESS_TOKEN"
        $turnUsername = Get-ProcessSecret "MESH_SMOKE_TURN_USERNAME"
        $turnPassword = Get-ProcessSecret "MESH_SMOKE_TURN_PASSWORD"
        $backupBearer = Get-ProcessSecret "MESH_SMOKE_BACKUP_BEARER_TOKEN"
        $monitoringBearer = Get-ProcessSecret "MESH_SMOKE_MONITORING_BEARER_TOKEN"

        $whoAmI = $null
        if ([string]::IsNullOrWhiteSpace($matrixAccessToken)) {
            Add-Failure "Account authentication, encrypted sync, Matrix media, and MatrixRTC authorization are blocked: inject MESH_SMOKE_MATRIX_ACCESS_TOKEN through the process environment."
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

            if ($null -eq $whoAmI) {
                Add-Failure "MatrixRTC authenticated token exchange is blocked because whoami did not pass."
            } else {
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
Write-Host "Mode: $(if ($Online) { 'production live' } else { 'static/offline' })"
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
