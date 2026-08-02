param(
    [switch]$SkipStart,
    [switch]$Reset
)

$ErrorActionPreference = 'Stop'
$spikeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtimeRoot = Join-Path $spikeRoot 'runtime'
$certRoot = Join-Path $runtimeRoot 'certs'
$synapseImage = 'matrixdotorg/synapse:v1.157.1@sha256:d1fce43d7501428c461f2758dc10342555b946dc9f1d03c1b1b8aec1a4e8d130'
$runningOnWindows = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
    [System.Runtime.InteropServices.OSPlatform]::Windows
)

function Remove-MatrixSpikeRuntimeDirectory {
    param([Parameter(Mandatory = $true)][string]$Target)

    try {
        Remove-Item -LiteralPath $Target -Recurse -Force -ErrorAction Stop
        return
    } catch {
        if ($runningOnWindows) {
            throw
        }
    }

    # Linux containers create Synapse store files as root in the bind mount.
    # Use the already pinned test image only after the caller has proven that
    # Target is a direct child of this fixture's runtime directory.
    $mount = "type=bind,source=$Target,target=/mesh-cleanup"
    & docker run --rm --user 0 --mount $mount $synapseImage sh -c `
        'find /mesh-cleanup -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +'
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to clean root-owned Matrix spike runtime data in $Target"
    }
    Remove-Item -LiteralPath $Target -Recurse -Force -ErrorAction Stop
}

if ($Reset) {
    Push-Location $spikeRoot
    try {
        & docker compose down
        if ($LASTEXITCODE -ne 0) { throw 'Failed to stop Matrix spike services before reset' }
    } finally {
        Pop-Location
    }

    $runtimeFullPath = [System.IO.Path]::GetFullPath($runtimeRoot).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $runtimePrefix = $runtimeFullPath + [System.IO.Path]::DirectorySeparatorChar
    foreach ($directoryName in @('hs1', 'hs2')) {
        $target = [System.IO.Path]::GetFullPath((Join-Path $runtimeRoot $directoryName))
        if (-not $target.StartsWith($runtimePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to reset path outside the Matrix spike runtime: $target"
        }
        if (Test-Path -LiteralPath $target) {
            Remove-MatrixSpikeRuntimeDirectory -Target $target
        }
    }
}

$gitOpenSslConfig = 'C:\Program Files\Git\usr\ssl\openssl.cnf'
if ((-not $env:OPENSSL_CONF -or -not (Test-Path -LiteralPath $env:OPENSSL_CONF)) -and (Test-Path -LiteralPath $gitOpenSslConfig)) {
    $env:OPENSSL_CONF = $gitOpenSslConfig
}

New-Item -ItemType Directory -Force -Path $runtimeRoot, $certRoot | Out-Null

function Invoke-OpenSsl {
    & openssl @args
    if ($LASTEXITCODE -ne 0) { throw "OpenSSL failed with exit code $LASTEXITCODE" }
}

function Ensure-TestCertificate {
    param([string]$Name)
    $keyPath = Join-Path $certRoot "$Name.key"
    $csrPath = Join-Path $certRoot "$Name.csr"
    $certPath = Join-Path $certRoot "$Name.crt"
    if (Test-Path -LiteralPath $certPath) { return }

    Invoke-OpenSsl req -newkey rsa:2048 -nodes -keyout $keyPath -out $csrPath `
        -subj "/CN=$Name.mesh.test" -addext "subjectAltName=DNS:$Name.mesh.test"
    Invoke-OpenSsl x509 -req -in $csrPath -CA (Join-Path $certRoot 'test-ca.crt') `
        -CAkey (Join-Path $certRoot 'test-ca.key') -CAcreateserial -out $certPath `
        -days 30 -sha256 -copy_extensions copy
}

$caCert = Join-Path $certRoot 'test-ca.crt'
if (-not (Test-Path -LiteralPath $caCert)) {
    Invoke-OpenSsl req -x509 -newkey rsa:3072 -nodes `
        -keyout (Join-Path $certRoot 'test-ca.key') -out $caCert -days 30 -sha256 `
        -subj '/CN=Mesh Matrix Spike Test CA'
}
Ensure-TestCertificate -Name 'hs1'
Ensure-TestCertificate -Name 'hs2'

function Ensure-SynapseConfig {
    param(
        [string]$DirectoryName,
        [string]$ServerName,
        [int]$HostPort
    )
    $dataPath = Join-Path $runtimeRoot $DirectoryName
    New-Item -ItemType Directory -Force -Path $dataPath | Out-Null
    $configPath = Join-Path $dataPath 'homeserver.yaml'
    if (-not (Test-Path -LiteralPath $configPath)) {
        $dockerRunArguments = @('run', '--rm')
        if (-not $runningOnWindows) {
            $userId = (& id -u).Trim()
            if ($LASTEXITCODE -ne 0 -or $userId -notmatch '^\d+$') {
                throw 'Could not determine the Unix user ID for Matrix spike setup'
            }
            $groupId = (& id -g).Trim()
            if ($LASTEXITCODE -ne 0 -or $groupId -notmatch '^\d+$') {
                throw 'Could not determine the Unix group ID for Matrix spike setup'
            }
            $dockerRunArguments += @('--user', "${userId}:${groupId}")
        }
        $dockerRunArguments += @(
            '-v',
            "${dataPath}:/data",
            '-e',
            "SYNAPSE_SERVER_NAME=$ServerName",
            '-e',
            'SYNAPSE_REPORT_STATS=no',
            $synapseImage,
            'generate'
        )
        & docker @dockerRunArguments
        if ($LASTEXITCODE -ne 0) { throw "Failed to generate Synapse config for $ServerName" }

        Add-Content -LiteralPath $configPath -Value @"

# Mesh architecture-spike overrides. Development only.
public_baseurl: "http://localhost:$HostPort/"
enable_registration: true
enable_registration_without_verification: false
registration_requires_token: true
federation_custom_ca_list:
  - /data/test-ca.crt
"@
    }
    $configText = Get-Content -LiteralPath $configPath -Raw
    $updatedConfig = $configText -replace `
        '(?m)^enable_registration_without_verification:\s*true\s*$', `
        'enable_registration_without_verification: false'
    if ($updatedConfig -notmatch '(?m)^registration_requires_token:\s*true\s*$') {
        $updatedConfig += "`nregistration_requires_token: true`n"
    }
    if ($updatedConfig -ne $configText) {
        [System.IO.File]::WriteAllText(
            $configPath,
            $updatedConfig,
            [System.Text.UTF8Encoding]::new($false)
        )
        $configText = $updatedConfig
    }
    if ($configText -notmatch 'Mesh local-federation networking') {
        Add-Content -LiteralPath $configPath -Value @"

# Mesh local-federation networking. Development only: permit Docker bridge
# addresses and remove invite throttling so repeated acceptance runs are deterministic.
ip_range_whitelist:
  - 172.16.0.0/12
rc_invites:
  per_room:
    per_second: 100
    burst_count: 100
  per_user:
    per_second: 100
    burst_count: 100
  per_issuer:
    per_second: 100
    burst_count: 100
"@
    }
    if ($configText -notmatch 'Mesh test room-directory publication') {
        Add-Content -LiteralPath $configPath -Value @"

# Mesh test room-directory publication. Development only: current Synapse
# defaults require explicit operator policy before non-admins may publish or
# another homeserver may query the directory over federation.
room_list_publication_rules:
  - action: allow
allow_public_rooms_over_federation: true
"@
    }
    Copy-Item -LiteralPath $caCert -Destination (Join-Path $dataPath 'test-ca.crt') -Force
    if (-not $runningOnWindows) {
        # Disposable CI only: the host runner owns setup files while Synapse
        # runs as UID 991. Keep the gitignored runtime mutually accessible so
        # reset can rewrite it and the container can create its SQLite/media
        # state. Production homeserver permissions are configured elsewhere.
        & chmod 0777 $dataPath
        if ($LASTEXITCODE -ne 0) {
            throw "Could not grant Synapse write access to $dataPath"
        }
        foreach ($runtimeFile in Get-ChildItem -LiteralPath $dataPath -File) {
            & chmod 0644 $runtimeFile.FullName
            if ($LASTEXITCODE -ne 0) {
                throw "Could not grant Synapse read access to $($runtimeFile.FullName)"
            }
        }
    }
}

Ensure-SynapseConfig -DirectoryName 'hs1' -ServerName 'hs1.mesh.test' -HostPort 8008
Ensure-SynapseConfig -DirectoryName 'hs2' -ServerName 'hs2.mesh.test' -HostPort 8009

if ($SkipStart) { return }

Push-Location $spikeRoot
try {
    & docker compose up -d
    if ($LASTEXITCODE -ne 0) { throw 'Failed to start Matrix spike services' }
    & docker compose restart synapse1 synapse2
    if ($LASTEXITCODE -ne 0) { throw 'Failed to reload Synapse development configuration' }

    $deadline = (Get-Date).AddMinutes(2)
    do {
        try {
            $hs1 = Invoke-RestMethod -Uri 'http://localhost:8008/_matrix/client/versions' -TimeoutSec 2
            $hs2 = Invoke-RestMethod -Uri 'http://localhost:8009/_matrix/client/versions' -TimeoutSec 2
            if ($hs1.versions.Count -gt 0 -and $hs2.versions.Count -gt 0) { break }
        } catch {
            Start-Sleep -Seconds 2
        }
    } while ((Get-Date) -lt $deadline)

    if ((Get-Date) -ge $deadline) { throw 'Synapse homeservers did not become ready within two minutes' }

    & docker compose exec -T synapse1 register_new_matrix_user -c /data/homeserver.yaml `
        http://localhost:8008 -u alice -p mesh-alice --no-admin 2>&1 | Out-Host
    & docker compose exec -T synapse1 register_new_matrix_user -c /data/homeserver.yaml `
        http://localhost:8008 -u charlie -p mesh-charlie --no-admin 2>&1 | Out-Host
    & docker compose exec -T synapse1 register_new_matrix_user -c /data/homeserver.yaml `
        http://localhost:8008 -u meshadmin -p mesh-admin --admin 2>&1 | Out-Host
    & docker compose exec -T synapse2 register_new_matrix_user -c /data/homeserver.yaml `
        http://localhost:8008 -u bob -p mesh-bob --no-admin 2>&1 | Out-Host

    $adminLogin = Invoke-RestMethod `
        -Uri 'http://localhost:8008/_matrix/client/v3/login' `
        -Method Post `
        -ContentType 'application/json' `
        -Body (@{
            type = 'm.login.password'
            identifier = @{
                type = 'm.id.user'
                user = '@meshadmin:hs1.mesh.test'
            }
            password = 'mesh-admin'
            initial_device_display_name = 'Mesh registration acceptance'
        } | ConvertTo-Json -Depth 4)
    $adminHeaders = @{ Authorization = "Bearer $($adminLogin.access_token)" }
    $registrationTokenBody = @{
        token = 'mesh-spike-registration'
        uses_allowed = $null
        expiry_time = $null
    } | ConvertTo-Json
    try {
        Invoke-RestMethod `
            -Uri 'http://localhost:8008/_synapse/admin/v1/registration_tokens/new' `
            -Method Post `
            -Headers $adminHeaders `
            -ContentType 'application/json' `
            -Body $registrationTokenBody | Out-Null
    } catch {
        if ($_.Exception.Response.StatusCode.value__ -ne 400) { throw }
        Invoke-RestMethod `
            -Uri 'http://localhost:8008/_synapse/admin/v1/registration_tokens/mesh-spike-registration' `
            -Method Put `
            -Headers $adminHeaders `
            -ContentType 'application/json' `
            -Body (@{ uses_allowed = $null; expiry_time = $null } | ConvertTo-Json) | Out-Null
    } finally {
        Invoke-RestMethod `
            -Uri 'http://localhost:8008/_matrix/client/v3/logout' `
            -Method Post `
            -Headers $adminHeaders `
            -ContentType 'application/json' `
            -Body '{}' | Out-Null
    }

    Write-Output 'Matrix spike homeservers are ready:'
    Write-Output '  Alice: @alice:hs1.mesh.test at http://localhost:8008 (password mesh-alice)'
    Write-Output '  Charlie: @charlie:hs1.mesh.test at http://localhost:8008 (password mesh-charlie)'
    Write-Output '  Bob:   @bob:hs2.mesh.test at http://localhost:8009 (password mesh-bob)'
    Write-Output '  Registration: invitation token UI-auth is required'
    Write-Output 'Run: npm run test:matrix-spike'
} finally {
    Pop-Location
}
