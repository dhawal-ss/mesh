param(
    [Parameter(Mandatory = $true)]
    [string]$SyftPath,

    [Parameter(Mandatory = $true)]
    [string]$GrypePath,

    [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$prototypeRoot = Join-Path $projectRoot "infra/container-prototypes"
$policyPath = Join-Path $prototypeRoot "prototype-policy.json"
$policy = Get-Content -LiteralPath $policyPath -Raw | ConvertFrom-Json

if (-not (Test-Path -LiteralPath $SyftPath -PathType Leaf)) {
    throw "Syft executable was not found at the supplied path."
}
if (-not (Test-Path -LiteralPath $GrypePath -PathType Leaf)) {
    throw "Grype executable was not found at the supplied path."
}

$syftHash = (Get-FileHash -LiteralPath $SyftPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($syftHash -ne $policy.scannerPolicy.syftWindowsAmd64Sha256) {
    throw "Local prototypes require the policy-pinned Syft Windows AMD64 executable."
}
$grypeHash = (Get-FileHash -LiteralPath $GrypePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($grypeHash -ne $policy.scannerPolicy.grypeWindowsAmd64Sha256) {
    throw "Local prototypes require the policy-pinned Grype Windows AMD64 executable."
}

$syftVersion = (& $SyftPath version 2>&1 | Out-String)
if ($syftVersion -notmatch "Version:\s+1\.50\.0\b") {
    throw "Local prototypes require checksum-verified Syft $($policy.scannerPolicy.syftVersion)."
}
$grypeVersion = (& $GrypePath version 2>&1 | Out-String)
if ($grypeVersion -notmatch "Version:\s+0\.116\.1\b") {
    throw "Local prototypes require checksum-verified Grype $($policy.scannerPolicy.grypeVersion)."
}

$dockerVersion = docker version --format '{{.Server.Version}}' 2>&1
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($dockerVersion | Out-String))) {
    throw "Docker is unavailable; local prototype builds are blocked."
}

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("mesh-container-prototypes-" + [guid]::NewGuid().ToString("N"))
}
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $resolvedOutput | Out-Null

$results = @()
$blockedResults = @()
$failures = @()
$policySha256 = (Get-FileHash -LiteralPath $policyPath -Algorithm SHA256).Hash.ToLowerInvariant()
$buildScriptPath = Join-Path $PSScriptRoot "build-local-container-prototypes.ps1"
$buildScriptSha256 = (Get-FileHash -LiteralPath $buildScriptPath -Algorithm SHA256).Hash.ToLowerInvariant()

function ConvertTo-SymbolicMode {
    param(
        [Parameter(Mandatory = $true)][string]$Mode,
        [Parameter(Mandatory = $true)][string]$Type
    )
    $symbols = if ($Type -eq "directory") { "d" } else { "-" }
    foreach ($digit in $Mode.Substring(1).ToCharArray()) {
        $value = [Convert]::ToInt32([string]$digit, 10)
        $symbols += if (($value -band 4) -ne 0) { "r" } else { "-" }
        $symbols += if (($value -band 2) -ne 0) { "w" } else { "-" }
        $symbols += if (($value -band 1) -ne 0) { "x" } else { "-" }
    }
    return $symbols
}

function Get-ScannerEvidence {
    param(
        [Parameter(Mandatory = $true)][object]$Scan,
        [Parameter(Mandatory = $true)][object]$ScannerPolicy,
        [Parameter(Mandatory = $true)][string]$ExpectedSource
    )

    $findings = @($scan.matches)
    $highOrCriticalFindings = @($findings | Where-Object { $_.vulnerability.severity -in @("High", "Critical") })
    $scanErrors = @()
    $scanTimestamp = [string]$Scan.descriptor.timestamp
    $databaseStatus = $Scan.descriptor.db.status
    $databaseSource = [string]$databaseStatus.from
    $databaseBuilt = [string]$databaseStatus.built
    $databaseChecksumMatch = [regex]::Match(
        $databaseSource,
        '(?:\?|&)checksum=sha256(?:%3A|:)(?<checksum>[0-9a-f]{64})(?:&|$)',
        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    )
    [DateTimeOffset]$scanTimestampValue = [DateTimeOffset]::MinValue
    [DateTimeOffset]$databaseBuiltValue = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse($scanTimestamp, [ref]$scanTimestampValue)) {
        $scanErrors += "scan timestamp is invalid"
    }
    if (-not [DateTimeOffset]::TryParse($databaseBuilt, [ref]$databaseBuiltValue)) {
        $scanErrors += "database build timestamp is invalid"
    }
    if ($Scan.source.type -ne "image" -or $Scan.source.target.userInput -ne $ExpectedSource) {
        $scanErrors += "scan source does not match the requested image"
    }
    if ($databaseSource -notlike "$($ScannerPolicy.database.sourceOrigin)*") {
        $scanErrors += "database source is not the policy-approved origin"
    }
    if (-not $databaseChecksumMatch.Success) {
        $scanErrors += "database source is not bound to an exact SHA-256"
    }
    if ([string]$databaseStatus.schemaVersion -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') {
        $scanErrors += "database schema version is invalid"
    }
    if ($ScannerPolicy.database.requireValid -and $databaseStatus.valid -ne $true) {
        $scanErrors += "database status is invalid"
    }
    if ($Scan.descriptor.version -ne $ScannerPolicy.grypeVersion.TrimStart('v')) {
        $scanErrors += "scan descriptor does not match the policy-pinned Grype version"
    }
    if ($Scan.descriptor.configuration.'only-fixed' -ne $ScannerPolicy.onlyFixable -or
        $Scan.descriptor.configuration.'fail-on-severity' -ne $ScannerPolicy.severityCutoff) {
        $scanErrors += "scan configuration does not enforce the policy severity and fixability boundary"
    }
    $databaseConfiguration = $Scan.descriptor.configuration.db
    $expectedDatabaseMaxAgeNanoseconds = [long]$ScannerPolicy.database.maxAgeHours * 60L * 60L * 1000000000L
    if ($databaseConfiguration.'update-url'.TrimEnd('/') -ne $ScannerPolicy.database.sourceOrigin.TrimEnd('/')) {
        $scanErrors += "database update URL is not the policy-approved origin"
    }
    if ($ScannerPolicy.database.requireHashValidation -and
        $databaseConfiguration.'validate-by-hash-on-start' -ne $true) {
        $scanErrors += "database hash validation is disabled"
    }
    if ($databaseConfiguration.'validate-age' -ne $true -or
        [long]$databaseConfiguration.'max-allowed-built-age' -ne $expectedDatabaseMaxAgeNanoseconds) {
        $scanErrors += "database age validation does not match policy"
    }
    if ($scanTimestampValue -ne [DateTimeOffset]::MinValue -and $databaseBuiltValue -ne [DateTimeOffset]::MinValue) {
        $databaseAge = $scanTimestampValue - $databaseBuiltValue
        if ($databaseAge.TotalSeconds -lt 0 -or $databaseAge.TotalHours -gt [double]$ScannerPolicy.database.maxAgeHours) {
            $scanErrors += "database was future-dated or stale when the scan ran"
        }
    }

    return [pscustomobject][ordered]@{
        Errors = @($scanErrors)
        FixedFindings = $findings.Count
        FixedHighOrCriticalFindings = $highOrCriticalFindings.Count
        ScannedAt = $scanTimestamp
        Database = [ordered]@{
            schemaVersion = [string]$databaseStatus.schemaVersion
            built = $databaseBuilt
            source = $databaseSource
            checksumSha256 = if ($databaseChecksumMatch.Success) { $databaseChecksumMatch.Groups['checksum'].Value.ToLowerInvariant() } else { "" }
            valid = $databaseStatus.valid
        }
    }
}

foreach ($prototype in @($policy.prototypes | Where-Object { $_.status -eq "buildable-local" })) {
    $startedOn = (Get-Date).ToUniversalTime().ToString("o")
    $invocationId = [guid]::NewGuid().ToString("D")
    $context = Join-Path $projectRoot $prototype.context
    $dockerfile = Join-Path $projectRoot $prototype.dockerfile
    Write-Host "Building local-only $($prototype.name) prototype as $($prototype.localTag)..."
    docker build --provenance=false --file $dockerfile --tag $prototype.localTag $context
    if ($LASTEXITCODE -ne 0) {
        throw "Docker build failed for $($prototype.name)."
    }
    $imageId = (docker image inspect $prototype.localTag --format '{{.Id}}' | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $imageId -notmatch '^sha256:[0-9a-f]{64}$') {
        throw "Could not resolve the local image ID for $($prototype.name)."
    }
    Write-Host "Verifying repeat image ID for $($prototype.name)..."
    docker build --provenance=false --file $dockerfile --tag $prototype.localTag $context
    if ($LASTEXITCODE -ne 0) {
        throw "Repeated Docker build failed for $($prototype.name)."
    }
    $repeatImageId = (docker image inspect $prototype.localTag --format '{{.Id}}' | Out-String).Trim()
    if ($repeatImageId -ne $imageId) {
        throw "$($prototype.name) did not reproduce the same local image ID."
    }
    $imageConfigJson = (docker image inspect $prototype.localTag --format '{{json .Config}}' | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($imageConfigJson)) {
        throw "Could not resolve the local image configuration for $($prototype.name)."
    }
    $imageConfig = $imageConfigJson | ConvertFrom-Json
    if ($imageConfig.User -ne $prototype.runtime.user) {
        throw "$($prototype.name) runtime user does not match the non-root policy."
    }
    if ($imageConfig.WorkingDir -ne $prototype.runtime.workingDirectory) {
        throw "$($prototype.name) runtime working directory does not match policy."
    }
    $actualCommandJson = ConvertTo-Json -InputObject @($imageConfig.Cmd) -Compress
    $expectedCommandJson = ConvertTo-Json -InputObject @($prototype.runtime.command) -Compress
    if ($actualCommandJson -ne $expectedCommandJson) {
        throw "$($prototype.name) runtime command does not match policy."
    }
    $actualPorts = @($imageConfig.ExposedPorts.PSObject.Properties.Name | Sort-Object)
    $expectedPorts = @($prototype.runtime.exposedPorts | Sort-Object)
    if (@(Compare-Object -ReferenceObject $expectedPorts -DifferenceObject $actualPorts).Count -ne 0) {
        throw "$($prototype.name) exposed ports do not match policy."
    }
    foreach ($label in $prototype.runtime.labels.PSObject.Properties) {
        $actualLabel = $imageConfig.Labels.PSObject.Properties[$label.Name].Value
        if ($actualLabel -ne $label.Value) {
            throw "$($prototype.name) runtime label $($label.Name) does not match policy."
        }
    }
    $runtimeEvidence = [ordered]@{
        user = $prototype.runtime.user
        workingDirectory = $prototype.runtime.workingDirectory
        command = @($prototype.runtime.command)
        exposedPorts = @($prototype.runtime.exposedPorts)
        labels = $prototype.runtime.labels
        containment = $prototype.runtime.containment
        payloadPermissions = @($prototype.runtime.payloadPermissions)
    }
    $containmentArgs = @(
        "--read-only",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true"
    )
    foreach ($temporaryFilesystem in @($prototype.runtime.containment.temporaryFilesystems)) {
        $containmentArgs += @("--tmpfs", "$($temporaryFilesystem.path):$($temporaryFilesystem.options)")
    }

    $payloadTarPath = Join-Path $resolvedOutput "$($prototype.name)-payload.tar"
    $payloadContainerId = docker create $prototype.localTag
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($payloadContainerId)) {
        throw "Could not create the payload inspection container for $($prototype.name)."
    }
    try {
        docker export --output $payloadTarPath $payloadContainerId
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $payloadTarPath -PathType Leaf)) {
            throw "Could not export the final runtime payload for $($prototype.name)."
        }
        $payloadListing = @(tar -tvf $payloadTarPath 2>&1)
        if ($LASTEXITCODE -ne 0) { throw "Could not inspect runtime payload permissions for $($prototype.name)." }
        $payloadPaths = @(tar -tf $payloadTarPath 2>&1 | ForEach-Object { ([string]$_).TrimStart(".", "/") })
        if ($LASTEXITCODE -ne 0) { throw "Could not inspect runtime payload paths for $($prototype.name)." }

        foreach ($permission in @($prototype.runtime.payloadPermissions)) {
            $archivePath = $permission.path.TrimStart("/")
            if ($permission.type -eq "directory") { $archivePath += "/" }
            $pathPattern = "\s" + [regex]::Escape($archivePath) + "`$"
            $matchingLines = @($payloadListing | Where-Object { $_ -match $pathPattern })
            if ($matchingLines.Count -ne 1) {
                throw "$($prototype.name) payload is missing reviewed path $($permission.path)."
            }
            $expectedSymbolicMode = ConvertTo-SymbolicMode -Mode $permission.mode -Type $permission.type
            if (-not $matchingLines[0].StartsWith($expectedSymbolicMode)) {
                throw "$($prototype.name) payload mode does not match policy for $($permission.path)."
            }
            if ($matchingLines[0] -notmatch '^[^\s]+\s+\d+\s+(?<uid>\d+)\s+(?<gid>\d+)\s+') {
                throw "$($prototype.name) payload owner could not be read for $($permission.path)."
            }
            if ("$($Matches.uid):$($Matches.gid)" -ne $permission.owner) {
                throw "$($prototype.name) payload owner does not match policy for $($permission.path)."
            }
        }

        $forbiddenPathsPresent = @()
        foreach ($forbiddenPath in @($policy.payloadPolicy.forbiddenPaths)) {
            $pathMatches = @(if ($forbiddenPath.EndsWith("/")) {
                $payloadPaths | Where-Object { $_.StartsWith($forbiddenPath, [System.StringComparison]::Ordinal) }
            }
            else {
                $payloadPaths | Where-Object { $_ -eq $forbiddenPath }
            })
            if ($pathMatches.Count -gt 0) { $forbiddenPathsPresent += $forbiddenPath }
        }
        if ($forbiddenPathsPresent.Count -gt 0) {
            throw "$($prototype.name) payload contains forbidden runtime paths: $($forbiddenPathsPresent -join ', ')."
        }
    }
    finally {
        docker rm $payloadContainerId 2>$null | Out-Null
        if (Test-Path -LiteralPath $payloadTarPath -PathType Leaf) {
            Remove-Item -LiteralPath $payloadTarPath -Force
        }
    }

    $payloadPath = Join-Path $resolvedOutput "$($prototype.name)-payload.json"
    [ordered]@{
        schemaVersion = 1
        imageId = $imageId
        entries = @($prototype.runtime.payloadPermissions)
        forbiddenPathsPresent = @()
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $payloadPath -Encoding utf8
    $payloadSha256 = (Get-FileHash -LiteralPath $payloadPath -Algorithm SHA256).Hash.ToLowerInvariant()

    if ($prototype.name -eq "caddy") {
        docker run @containmentArgs --rm $prototype.localTag caddy version
        if ($LASTEXITCODE -ne 0) { throw "Caddy version smoke check failed." }
        docker run @containmentArgs --rm $prototype.localTag caddy validate --config /etc/caddy/Caddyfile
        if ($LASTEXITCODE -ne 0) { throw "Caddy configuration smoke check failed." }
        $caddyContainerId = docker run @containmentArgs --detach --rm --publish 127.0.0.1::80 $prototype.localTag
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($caddyContainerId)) {
            throw "Caddy failed to start for its HTTP smoke check."
        }
        try {
            $caddyHealthy = $false
            for ($attempt = 0; $attempt -lt 20; $attempt++) {
                $portLine = docker port $caddyContainerId 80/tcp 2>$null
                if ($LASTEXITCODE -eq 0 -and $portLine -match '127\.0\.0\.1:(?<port>[0-9]+)$') {
                    try {
                        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($Matches.port)/" -TimeoutSec 2
                        if ($response.StatusCode -eq 200) {
                            $caddyHealthy = $true
                            break
                        }
                    }
                    catch {
                        # The bounded startup loop retries until the server is listening.
                    }
                }
                Start-Sleep -Milliseconds 500
            }
            if (-not $caddyHealthy) { throw "Caddy HTTP smoke check did not become ready." }
        }
        finally {
            docker rm --force $caddyContainerId 2>$null | Out-Null
        }
    }
    elseif ($prototype.name -eq "lk-jwt-service") {
        $containerId = docker run @containmentArgs --detach --rm --publish 127.0.0.1::8080 `
            --env LIVEKIT_URL=ws://127.0.0.1:7880 `
            --env LIVEKIT_KEY=devkey `
            --env LIVEKIT_SECRET=secret `
            --env LIVEKIT_FULL_ACCESS_HOMESERVERS=example.test `
            $prototype.localTag
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($containerId)) {
            throw "lk-jwt-service failed to start for its health smoke check."
        }
        try {
            $healthy = $false
            for ($attempt = 0; $attempt -lt 20; $attempt++) {
                $portLine = docker port $containerId 8080/tcp 2>$null
                if ($LASTEXITCODE -eq 0 -and $portLine -match '127\.0\.0\.1:(?<port>[0-9]+)$') {
                    try {
                        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($Matches.port)/healthz" -TimeoutSec 2
                        if ($response.StatusCode -eq 200) {
                            $healthy = $true
                            break
                        }
                    }
                    catch {
                        # The bounded startup loop retries until the service is listening.
                    }
                }
                Start-Sleep -Milliseconds 500
            }
            if (-not $healthy) { throw "lk-jwt-service /healthz smoke check did not become ready." }
        }
        finally {
            docker rm --force $containerId 2>$null | Out-Null
        }
    }

    $sbomPath = Join-Path $resolvedOutput "$($prototype.name).cdx.json"
    & $SyftPath $imageId -o "cyclonedx-json=$sbomPath"
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $sbomPath -PathType Leaf)) {
        throw "CycloneDX SBOM generation failed for $($prototype.name)."
    }
    $sbomDocument = Get-Content -LiteralPath $sbomPath -Raw | ConvertFrom-Json
    $sbomComponents = @($sbomDocument.components)
    $sbomFormatMatches = $sbomDocument.bomFormat -eq "CycloneDX"
    $sbomVersionMatches = $sbomDocument.specVersion -eq $prototype.sbom.specVersion
    $sbomCountMatches = $sbomComponents.Count -eq $prototype.sbom.componentCount
    $sbomIdentityMatches = $sbomDocument.metadata.component.name -eq "sha256" -and $sbomDocument.metadata.component.version -eq $imageId.Substring(7)
    if (-not $sbomFormatMatches -or -not $sbomVersionMatches -or -not $sbomCountMatches -or -not $sbomIdentityMatches) {
        throw "$($prototype.name) SBOM identity or component count does not match policy."
    }
    foreach ($requiredComponent in @($prototype.sbom.requiredComponents)) {
        $requiredVersion = if ($null -ne $requiredComponent.PSObject.Properties["version"]) { [string]$requiredComponent.version } else { "" }
        $componentMatches = @($sbomComponents | Where-Object {
            $actualVersion = if ($null -ne $_.PSObject.Properties["version"]) { [string]$_.version } else { "" }
            $_.type -eq $requiredComponent.type -and $_.name -eq $requiredComponent.name -and $actualVersion -eq $requiredVersion
        })
        if ($componentMatches.Count -ne 1) {
            throw "$($prototype.name) SBOM is missing required component $($requiredComponent.name)@$requiredVersion."
        }
    }
    foreach ($forbiddenComponentName in @($prototype.sbom.forbiddenComponentNames)) {
        if (@($sbomComponents | Where-Object { $_.name -ieq $forbiddenComponentName }).Count -gt 0) {
            throw "$($prototype.name) SBOM contains forbidden builder component $forbiddenComponentName."
        }
    }

    $scanPath = Join-Path $resolvedOutput "$($prototype.name)-grype.json"
    & $GrypePath $imageId -o json --file $scanPath --fail-on $policy.scannerPolicy.severityCutoff --only-fixed
    $scanExit = $LASTEXITCODE
    $scan = Get-Content -LiteralPath $scanPath -Raw | ConvertFrom-Json
    $scannerEvidence = Get-ScannerEvidence -Scan $scan -ScannerPolicy $policy.scannerPolicy -ExpectedSource $imageId
    if ($scanExit -ne 0 -or $scannerEvidence.FixedFindings -ne 0 -or $scannerEvidence.Errors.Count -ne 0) {
        $failureDetails = @("$($scannerEvidence.FixedFindings) fixable findings") + @($scannerEvidence.Errors)
        $failures += "$($prototype.name) scan failed: $($failureDetails -join ', ')"
    }
    $scannerDatabase = $scannerEvidence.Database

    $sbomSha256 = (Get-FileHash -LiteralPath $sbomPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $scanSha256 = (Get-FileHash -LiteralPath $scanPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $contextFullPath = [System.IO.Path]::GetFullPath($context).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $contextFiles = @(Get-ChildItem -LiteralPath $contextFullPath -Recurse -File | Sort-Object FullName | ForEach-Object {
        $fileFullPath = [System.IO.Path]::GetFullPath($_.FullName)
        $relativePath = $fileFullPath.Substring($contextFullPath.Length + 1).Replace('\', '/')
        [ordered]@{
            path = $relativePath
            sha256 = (Get-FileHash -LiteralPath $fileFullPath -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    })
    $builderParts = $prototype.builderImage -split '@sha256:', 2
    if ($builderParts.Count -ne 2 -or $builderParts[1] -notmatch '^[0-9a-f]{64}$') {
        throw "Prototype builder image is not digest-bound for $($prototype.name)."
    }
    $resolvedDependencies = @(
        [ordered]@{
            name = "$($prototype.name)-source"
            uri = "$($prototype.source.repository)#$($prototype.source.commit)"
            digest = [ordered]@{ gitCommit = $prototype.source.commit }
        },
        [ordered]@{
            name = "go-builder"
            uri = "docker://$($builderParts[0])"
            digest = [ordered]@{ sha256 = $builderParts[1] }
        },
        [ordered]@{
            name = "prototype-policy"
            uri = "file:infra/container-prototypes/prototype-policy.json"
            digest = [ordered]@{ sha256 = $policySha256 }
        },
        [ordered]@{
            name = "local-build-script"
            uri = "file:scripts/build-local-container-prototypes.ps1"
            digest = [ordered]@{ sha256 = $buildScriptSha256 }
        },
        [ordered]@{
            name = "grype-vulnerability-database"
            uri = $scannerDatabase.source
            digest = [ordered]@{ sha256 = $scannerDatabase.checksumSha256 }
        }
    )
    $sourcePatchIndex = 0
    foreach ($sourcePatch in @($prototype.sourcePatches)) {
        $resolvedDependencies += [ordered]@{
            name = "$($prototype.name)-source-patch-$sourcePatchIndex"
            uri = "file:$($sourcePatch.path)"
            digest = [ordered]@{ sha256 = $sourcePatch.sha256 }
        }
        $sourcePatchIndex += 1
    }
    $finishedOn = (Get-Date).ToUniversalTime().ToString("o")
    $provenancePath = Join-Path $resolvedOutput "$($prototype.name).provenance.json"
    [ordered]@{
        _type = $policy.provenance.statementType
        subject = @(
            [ordered]@{
                name = $prototype.localTag
                digest = [ordered]@{ sha256 = $imageId.Substring(7) }
            }
        )
        predicateType = $policy.provenance.predicateType
        predicate = [ordered]@{
            buildDefinition = [ordered]@{
                buildType = $policy.provenance.buildType
                externalParameters = [ordered]@{
                    mode = $policy.mode
                    localTag = $prototype.localTag
                    source = [ordered]@{
                        repository = $prototype.source.repository
                        release = $prototype.source.release
                        commit = $prototype.source.commit
                        releaseArgument = $prototype.source.releaseArgument
                    }
                    sourcePatches = @($prototype.sourcePatches)
                    builderPackages = @($prototype.builderPackages)
                    dependencyOverrides = @($prototype.dependencyOverrides)
                }
                internalParameters = [ordered]@{
                    dockerfile = $prototype.dockerfile
                    context = $prototype.context
                    contextFiles = $contextFiles
                    runtime = $runtimeEvidence
                    localBuild = $policy.localBuild
                    payloadPolicy = $policy.payloadPolicy
                    sbomPolicy = $prototype.sbom
                    scannerPolicy = $policy.scannerPolicy
                    scannerDatabase = $scannerDatabase
                }
                resolvedDependencies = $resolvedDependencies
            }
            runDetails = [ordered]@{
                builder = [ordered]@{
                    id = $policy.provenance.builderId
                    version = [ordered]@{ docker = ($dockerVersion | Out-String).Trim() }
                }
                metadata = [ordered]@{
                    invocationId = $invocationId
                    startedOn = $startedOn
                    finishedOn = $finishedOn
                }
                byproducts = @(
                    [ordered]@{
                        name = "$($prototype.name).cdx.json"
                        mediaType = "application/vnd.cyclonedx+json"
                        digest = [ordered]@{ sha256 = $sbomSha256 }
                    },
                    [ordered]@{
                        name = "$($prototype.name)-grype.json"
                        mediaType = "application/json"
                        digest = [ordered]@{ sha256 = $scanSha256 }
                    },
                    [ordered]@{
                        name = "$($prototype.name)-payload.json"
                        mediaType = "application/json"
                        digest = [ordered]@{ sha256 = $payloadSha256 }
                    }
                )
            }
        }
    } | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $provenancePath -Encoding utf8
    $provenanceSha256 = (Get-FileHash -LiteralPath $provenancePath -Algorithm SHA256).Hash.ToLowerInvariant()

    $results += [ordered]@{
        name = $prototype.name
        localTag = $prototype.localTag
        localImageId = $imageId
        sourceCommit = $prototype.source.commit
        sbom = [ordered]@{
            path = $sbomPath
            sha256 = $sbomSha256
            componentCount = $sbomComponents.Count
            semanticVerified = $true
        }
        scan = [ordered]@{
            path = $scanPath
            sha256 = $scanSha256
            fixedFindings = $scannerEvidence.FixedFindings
            scannedAt = $scannerEvidence.ScannedAt
            database = $scannerDatabase
            passed = ($scanExit -eq 0 -and $scannerEvidence.FixedFindings -eq 0 -and $scannerEvidence.Errors.Count -eq 0)
        }
        runtime = $runtimeEvidence
        runtimeVerified = $true
        containmentVerified = $true
        payload = [ordered]@{
            path = $payloadPath
            sha256 = $payloadSha256
            verified = $true
            forbiddenPathsPresent = 0
        }
        reproducibility = [ordered]@{
            repeatedBuild = $true
            imageIdStable = ($repeatImageId -eq $imageId)
        }
        provenance = [ordered]@{
            path = $provenancePath
            sha256 = $provenanceSha256
            statementType = $policy.provenance.statementType
            predicateType = $policy.provenance.predicateType
            signed = $false
            signatureStatus = $policy.provenance.signatureStatus
        }
        signing = "blocked-until-protected-registry-push"
    }
}

foreach ($prototype in @($policy.prototypes | Where-Object { $_.status -eq "blocked-upstream" })) {
    $diagnosticResults = @()
    foreach ($diagnostic in @($prototype.diagnosticScans)) {
        if ([string]$diagnostic.name -notmatch '^[a-z0-9-]+$') {
            throw "$($prototype.name) diagnostic scan name is not path-safe."
        }
        Write-Host "Reproducing blocked $($prototype.name) $($diagnostic.name) scan..."
        $scanPath = Join-Path $resolvedOutput "$($prototype.name)-$($diagnostic.name)-grype.json"
        & $GrypePath $diagnostic.image -o json --file $scanPath --fail-on $policy.scannerPolicy.severityCutoff --only-fixed
        $scanExit = $LASTEXITCODE
        if (-not (Test-Path -LiteralPath $scanPath -PathType Leaf)) {
            throw "$($prototype.name) $($diagnostic.name) diagnostic scan did not produce evidence."
        }
        $scan = Get-Content -LiteralPath $scanPath -Raw | ConvertFrom-Json
        $scannerEvidence = Get-ScannerEvidence -Scan $scan -ScannerPolicy $policy.scannerPolicy -ExpectedSource $diagnostic.image
        $countsMatch = $scannerEvidence.FixedFindings -eq $diagnostic.fixedFindings -and `
            $scannerEvidence.FixedHighOrCriticalFindings -eq $diagnostic.fixedHighOrCriticalFindings
        if ($scanExit -ne 2 -or -not $countsMatch -or $scannerEvidence.Errors.Count -ne 0) {
            $failureDetails = @(
                "exit $scanExit",
                "$($scannerEvidence.FixedFindings) total fixable findings",
                "$($scannerEvidence.FixedHighOrCriticalFindings) fixed high or critical findings"
            ) + @($scannerEvidence.Errors)
            $failures += "$($prototype.name) $($diagnostic.name) blocked scan drifted: $($failureDetails -join ', ')"
        }
        $diagnosticResults += [ordered]@{
            name = $diagnostic.name
            image = $diagnostic.image
            path = $scanPath
            sha256 = (Get-FileHash -LiteralPath $scanPath -Algorithm SHA256).Hash.ToLowerInvariant()
            fixedFindings = $scannerEvidence.FixedFindings
            fixedHighOrCriticalFindings = $scannerEvidence.FixedHighOrCriticalFindings
            scannedAt = $scannerEvidence.ScannedAt
            database = $scannerEvidence.Database
            blockedAsExpected = ($scanExit -eq 2 -and $countsMatch -and $scannerEvidence.Errors.Count -eq 0)
        }
    }
    $blockedResults += [ordered]@{
        name = $prototype.name
        reason = $prototype.blockReason
        scans = $diagnosticResults
    }
}

$summaryPath = Join-Path $resolvedOutput "prototype-summary.json"
[ordered]@{
    schemaVersion = 3
    mode = "local-only"
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    dockerServerVersion = ($dockerVersion | Out-String).Trim()
    syftVersion = $policy.scannerPolicy.syftVersion
    grypeVersion = $policy.scannerPolicy.grypeVersion
    policySha256 = $policySha256
    buildScriptSha256 = $buildScriptSha256
    results = $results
    blocked = $blockedResults
} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $summaryPath -Encoding utf8

if ($failures.Count -gt 0) {
    throw ($failures -join "; ")
}

& node (Join-Path $PSScriptRoot "check-local-container-prototype-evidence.mjs") --summary $summaryPath
if ($LASTEXITCODE -ne 0) {
    throw "Local container prototype evidence validation failed."
}

Write-Host "Local container prototypes passed. Evidence: $summaryPath"
