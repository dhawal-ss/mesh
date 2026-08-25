[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$modulePath = Join-Path $PSScriptRoot "MatrixRtcEvidence.psm1"
$templatePath = Join-Path $PSScriptRoot "acceptance-matrix.example.json"
Import-Module $modulePath -Force

$testRoot = Join-Path ([IO.Path]::GetTempPath()) (
    "mesh-matrixrtc-evidence-" + [Guid]::NewGuid().ToString("N")
)
$sourceRoot = Join-Path $testRoot "source"
$evidenceRoot = Join-Path $testRoot "evidence"
$documentPath = Join-Path $testRoot "acceptance.json"
$outsidePath = Join-Path $testRoot "outside.log"
$passed = 0
$failed = 0

function Write-TestJson([object]$Document) {
    $Document |
        ConvertTo-Json -Depth 100 |
        Set-Content -LiteralPath $documentPath -Encoding UTF8
}

function Copy-TestDocument([object]$Document) {
    return $Document | ConvertTo-Json -Depth 100 | ConvertFrom-Json
}

function Invoke-EvidenceValidation([object]$Document) {
    Write-TestJson $Document
    return Test-MatrixRtcAcceptanceEvidence `
        -Path $documentPath `
        -EvidenceRoot $evidenceRoot `
        -SourceRoot $sourceRoot `
        -TrackedTemplatePath $templatePath `
        -RequireComplete
}

function Assert-ValidationPass(
    [string]$Name,
    [object]$Document
) {
    $result = Invoke-EvidenceValidation $Document
    if ($result.Failures.Count -gt 0) {
        $script:failed++
        Write-Host "[FAIL] $Name" -ForegroundColor Red
        foreach ($failure in $result.Failures) {
            Write-Host "       $failure" -ForegroundColor Red
        }
        return
    }
    $script:passed++
    Write-Host "[PASS] $Name" -ForegroundColor Green
}

function Assert-ValidationFailure(
    [string]$Name,
    [object]$Document,
    [string]$ExpectedPattern
) {
    $result = Invoke-EvidenceValidation $Document
    if ($result.Failures.Count -eq 0 -or
        -not (@($result.Failures | Where-Object { $_ -match $ExpectedPattern }))) {
        $script:failed++
        Write-Host "[FAIL] $Name" -ForegroundColor Red
        Write-Host "       Expected failure pattern: $ExpectedPattern" -ForegroundColor Red
        foreach ($failure in $result.Failures) {
            Write-Host "       Actual: $failure" -ForegroundColor Red
        }
        return
    }
    $script:passed++
    Write-Host "[PASS] $Name" -ForegroundColor Green
}

try {
    New-Item -ItemType Directory -Path $sourceRoot, $evidenceRoot -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $sourceRoot "baseline.txt") -Value "baseline"
    Set-Content -LiteralPath (Join-Path $sourceRoot ".gitignore") -Value "rtc-evidence/"
    & git -C $sourceRoot init --quiet
    & git -C $sourceRoot config user.name "Mesh evidence tests"
    & git -C $sourceRoot config user.email "mesh-evidence-tests@invalid.local"
    & git -C $sourceRoot add baseline.txt .gitignore
    & git -C $sourceRoot commit --quiet -m "test baseline"
    if ($LASTEXITCODE -ne 0) {
        throw "Could not create the isolated evidence-test Git repository."
    }
    $sourceSha = (& git -C $sourceRoot rev-parse HEAD).Trim()

    $capturedAt = [DateTimeOffset]::UtcNow.ToString("o")
    $document = Get-Content -LiteralPath $templatePath -Raw | ConvertFrom-Json
    $document.sourceSha = $sourceSha
    $document.testedAt = $capturedAt
    $document.operator = "Release verification engineer"
    $document.clientBuild = [pscustomobject]@{
        identifier = "Mesh signed beta build 2.4.1"
        sourceSha = $sourceSha
        artifactEvidenceId = "signed-client-build"
    }
    $document.homeservers = @("alpha.mesh.invalid", "bravo.mesh.invalid")
    $document.services = [pscustomobject]@{
        authorizationEndpoint = "https://rtc.mesh.invalid/livekit/jwt"
        sfuEndpoint = "wss://sfu.mesh.invalid/livekit/sfu"
        turnEndpoint = "turns:turn.mesh.invalid:443?transport=tcp"
    }
    $document.devices = @(
        [pscustomobject]@{
            id = "surface-laptop-six"
            platform = "Windows 11 24H2"
            description = "Surface Laptop 6 with the signed acceptance build."
        },
        [pscustomobject]@{
            id = "desktop-ryzen-nine"
            platform = "Windows 10 22H2"
            description = "Desktop workstation with the signed acceptance build."
        },
        [pscustomobject]@{
            id = "isolated-linux-client"
            platform = "Linux supported MatrixRTC client"
            description = "Faithfully isolated supported client used for the three-participant case."
        }
    )
    $document.networks = @(
        [pscustomobject]@{
            id = "wired-residential-lan"
            description = "Residential wired network used for same-LAN verification."
        },
        [pscustomobject]@{
            id = "cellular-hotspot"
            description = "Independent cellular hotspot used for cross-network verification."
        }
    )

    $artifactDefinitions = @(
        @{
            Id = "signed-client-build"
            Kind = "client-build"
            CaseId = $null
            File = "client-build.bin"
            MediaType = "application/octet-stream"
            Content = "signed Mesh test build bound to source $sourceSha"
            Description = "Signed disposable client build used by the validator acceptance fixture."
        }
    )
    foreach ($result in $document.results) {
        $caseId = [string]$result.id
        $transport = switch ($caseId) {
            "restrictive-nat" { "turn-udp" }
            "udp-blocked-turn-tcp-tls" { "turn-tcp-tls" }
            default { "direct" }
        }
        $result.status = "passed"
        $result.actual = "Expected behavior completed with encrypted media and clean participant teardown."
        $result.notApplicableReason = $null
        $result.deviceIds = if ($caseId -eq "three-person-call") {
            @("surface-laptop-six", "desktop-ryzen-nine", "isolated-linux-client")
        } else {
            @("surface-laptop-six", "desktop-ryzen-nine")
        }
        $result.networkIds = @("wired-residential-lan", "cellular-hotspot")
        $result.transport = $transport
        $result.mediaE2eeActive = $true
        $result.mediaE2eeFailureClosed = $caseId -eq "media-key-rotation-late-join"
        $result.evidenceIds = @(
            "$caseId-service",
            "$caseId-client",
            "$caseId-network"
        )
        $artifactDefinitions += @(
            @{
                Id = "$caseId-service"
                Kind = "service-log"
                CaseId = $caseId
                File = "$caseId-service.log"
                MediaType = "text/plain"
                Content = "case=$caseId phase=authorization outcome=ok"
                Description = "Content-free authorization and SFU lifecycle outcome for $caseId."
            },
            @{
                Id = "$caseId-client"
                Kind = "client-diagnostic"
                CaseId = $caseId
                File = "$caseId-client.log"
                MediaType = "text/plain"
                Content = "case=$caseId transport=$transport media_e2ee=active outcome=ok"
                Description = "Content-free client transport and encryption diagnostic for $caseId."
            },
            @{
                Id = "$caseId-network"
                Kind = "network-result"
                CaseId = $caseId
                File = "$caseId-network.log"
                MediaType = "text/plain"
                Content = "case=$caseId transport=$transport packet_loss=0 outcome=ok"
                Description = "Content-free network path result for $caseId."
            }
        )
    }

    $artifacts = @()
    foreach ($definition in $artifactDefinitions) {
        $artifactPath = Join-Path $evidenceRoot $definition.File
        Set-Content -LiteralPath $artifactPath -Value $definition.Content -NoNewline
        $artifacts += [pscustomobject]@{
            id = $definition.Id
            kind = $definition.Kind
            caseId = $definition.CaseId
            path = $definition.File
            sha256 = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
            byteSize = (Get-Item -LiteralPath $artifactPath).Length
            mediaType = $definition.MediaType
            capturedAt = $capturedAt
            description = $definition.Description
        }
    }
    $document.artifacts = $artifacts
    Set-Content -LiteralPath $outsidePath -Value "outside evidence root" -NoNewline

    Assert-ValidationPass "complete manifest passes" $document

    $externalEvidenceRoot = $evidenceRoot
    $ignoredEvidenceRoot = Join-Path $sourceRoot "rtc-evidence"
    New-Item -ItemType Directory -Path $ignoredEvidenceRoot | Out-Null
    Copy-Item -Path (Join-Path $externalEvidenceRoot "*") `
        -Destination $ignoredEvidenceRoot
    $evidenceRoot = $ignoredEvidenceRoot
    Assert-ValidationPass "explicitly ignored in-tree evidence passes" $document
    $evidenceRoot = $externalEvidenceRoot
    Remove-Item -LiteralPath $ignoredEvidenceRoot -Recurse -Force

    $unignoredEvidenceRoot = Join-Path $sourceRoot "unignored-evidence"
    New-Item -ItemType Directory -Path $unignoredEvidenceRoot | Out-Null
    Copy-Item -Path (Join-Path $externalEvidenceRoot "*") `
        -Destination $unignoredEvidenceRoot
    $evidenceRoot = $unignoredEvidenceRoot
    Assert-ValidationFailure `
        "unignored in-tree evidence is rejected" `
        $document `
        "explicitly ignored directory"
    $evidenceRoot = $externalEvidenceRoot
    Remove-Item -LiteralPath $unignoredEvidenceRoot -Recurse -Force

    Set-Content -LiteralPath (Join-Path $sourceRoot "untracked.txt") -Value "dirty"
    Assert-ValidationFailure `
        "dirty source is rejected" `
        $document `
        "clean tracked and untracked"
    Remove-Item -LiteralPath (Join-Path $sourceRoot "untracked.txt") -Force

    $mutated = Copy-TestDocument $document
    $mutated.sourceSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    $mutated.clientBuild.sourceSha = $mutated.sourceSha
    Assert-ValidationFailure "wrong source SHA is rejected" $mutated "sourceSha must equal"

    $mutated = Copy-TestDocument $document
    $mutated.services.authorizationEndpoint = "https://rtc.mesh.invalid/livekit/jwt?access_token=secret"
    Assert-ValidationFailure "credential-bearing auth endpoint is rejected" $mutated "reviewed public port"

    $mutated = Copy-TestDocument $document
    $mutated.services.sfuEndpoint = "wss://sfu.mesh.invalid/livekit/sfu#unreviewed"
    Assert-ValidationFailure "fragmented SFU endpoint is rejected" $mutated "reviewed public port"

    $mutated = Copy-TestDocument $document
    $mutated.services.turnEndpoint = "turns:turn.mesh.invalid:5349?transport=tcp"
    Assert-ValidationFailure "private TURN backend port is rejected" $mutated "reviewed public port"

    $mutated = Copy-TestDocument $document
    $mutated.artifacts[1].path = "missing.log"
    Assert-ValidationFailure "missing artifact is rejected" $mutated "file does not exist"

    $mutated = Copy-TestDocument $document
    $mutated.artifacts[1].sha256 = ("0" * 64)
    Assert-ValidationFailure "changed hash is rejected" $mutated "SHA-256 does not match"

    $mutated = Copy-TestDocument $document
    $mutated.artifacts[1].path = "..\outside.log"
    Assert-ValidationFailure "path escape is rejected" $mutated "cannot contain traversal"

    $linkedOutsideRoot = Join-Path $testRoot "linked-outside-target"
    $linkedOutsideFile = Join-Path $linkedOutsideRoot "linked.log"
    $evidenceLink = Join-Path $evidenceRoot "linked-outside"
    New-Item -ItemType Directory -Path $linkedOutsideRoot | Out-Null
    Set-Content -LiteralPath $linkedOutsideFile -Value "linked evidence escape" -NoNewline
    $linkType = if ([Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
        [Runtime.InteropServices.OSPlatform]::Windows
    )) { "Junction" } else { "SymbolicLink" }
    New-Item `
        -ItemType $linkType `
        -Path $evidenceLink `
        -Target $linkedOutsideRoot | Out-Null
    $mutated = Copy-TestDocument $document
    $mutated.artifacts[1].path = "linked-outside/linked.log"
    Assert-ValidationFailure `
        "symlink or junction escape is rejected" `
        $mutated `
        "symbolic links or junctions"

    $mutated = Copy-TestDocument $document
    $mutated.artifacts[1].id = "signed-client-build"
    Assert-ValidationFailure "duplicate artifact ID is rejected" $mutated "artifact ID is duplicated"

    $mutated = Copy-TestDocument $document
    $mutated.results[0].evidenceIds = @("service-log-main", "unknown-evidence")
    Assert-ValidationFailure "unknown evidence reference is rejected" $mutated "unknown evidence ID"

    $mutated = Copy-TestDocument $document
    $mutated.results[0].deviceIds[0] = "unregistered-device"
    Assert-ValidationFailure "wrong device is rejected" $mutated "unknown device ID"

    $mutated = Copy-TestDocument $document
    ($mutated.results | Where-Object { $_.id -eq "restrictive-nat" }).transport = "direct"
    Assert-ValidationFailure "missing TURN relay observation is rejected" $mutated "must prove TURN-relayed media"

    $mutated = Copy-TestDocument $document
    $mutated.results[0].mediaE2eeActive = $false
    Assert-ValidationFailure "missing media E2EE observation is rejected" $mutated "must attest active media E2EE"

    $mutated = Copy-TestDocument $document
    $mutated.results[0].evidenceIds[0] = $mutated.results[1].evidenceIds[0]
    Assert-ValidationFailure "generic cross-case evidence is rejected" $mutated "wrong caseId"

    $mutated = Copy-TestDocument $document
    $mutated.results[0].evidenceIds = @(
        $mutated.results[0].evidenceIds |
            Where-Object { $_ -notmatch "-network$" }
    )
    Assert-ValidationFailure "missing network result is rejected" $mutated "network-result artifact"

    $mutated = Copy-TestDocument $document
    $mutated.testedAt = [DateTimeOffset]::UtcNow.AddDays(-31).ToString("o")
    Assert-ValidationFailure "stale timestamp is rejected" $mutated "no more than 30 days old"

    $mutated = Copy-TestDocument $document
    $mutated.testedAt = [DateTimeOffset]::UtcNow.AddHours(1).ToString("o")
    Assert-ValidationFailure "future timestamp is rejected" $mutated "cannot be future-dated"

    $mutated = Copy-TestDocument $document
    $mutated.results[0].status = "not-run"
    $mutated.results[0].actual = ""
    Assert-ValidationFailure "incomplete case is rejected" $mutated "acceptance is incomplete"

    $mutated = Copy-TestDocument $document
    $mutated.operator = "REPLACE_WITH_OPERATOR"
    Assert-ValidationFailure "placeholder content is rejected" $mutated "responsible operator"
} finally {
    $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
    $resolvedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolvedTestRoot.StartsWith(
        $resolvedTempRoot,
        [StringComparison]::OrdinalIgnoreCase
    ) -and (Test-Path -LiteralPath $resolvedTestRoot)) {
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}

Write-Host ""
Write-Host "MatrixRTC evidence validator tests: $passed passed, $failed failed."
if ($failed -gt 0) {
    exit 1
}
