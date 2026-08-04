Set-StrictMode -Version Latest

$script:RequiredMatrixRtcCases = @(
    "two-windows-same-lan",
    "two-windows-different-networks",
    "windows-plus-supported-client",
    "restrictive-nat",
    "udp-blocked-turn-tcp-tls",
    "network-loss-reconnect",
    "active-kick",
    "active-ban",
    "logout-during-call",
    "device-removal-during-call",
    "permission-loss-during-call",
    "room-departure-during-call",
    "screen-share-start-stop",
    "screen-share-permission-denied",
    "app-restart-during-call",
    "app-restart-after-call",
    "media-key-rotation-late-join",
    "three-person-call",
    "larger-invited-call",
    "cross-service-call",
    "input-output-device-switch",
    "push-to-talk-deafen-mute",
    "concurrent-camera-screen-share"
)
$script:NotApplicableMatrixRtcCases = @("windows-plus-supported-client")
$script:AllowedObservedTransports = @(
    "not-observed",
    "direct",
    "turn-udp",
    "turn-tcp-tls",
    "mixed"
)
$script:TwoNetworkMatrixRtcCases = @(
    "two-windows-different-networks",
    "restrictive-nat",
    "udp-blocked-turn-tcp-tls",
    "network-loss-reconnect"
)
$script:AllowedArtifactKinds = @(
    "client-build",
    "service-log",
    "client-diagnostic",
    "network-result",
    "screenshot",
    "operator-record"
)
$script:ExpectedLiveKitImage = "livekit/livekit-server:v1.13.5@sha256:3497163e091d8418a915d41d99a2dfba6715e6b44a3ba662c979819b618f7af4"
$script:ExpectedAuthorizationImage = "ghcr.io/element-hq/lk-jwt-service:0.4.4@sha256:9c715697c6f7c1f538f2ee41b7b59b04a8d06bf790a7cc8c8517ccac8d28813d"

function Get-EvidenceProperty {
    param(
        [AllowNull()]
        [object]$Object,
        [Parameter(Mandatory)]
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

function Test-EvidencePlaceholder {
    param([AllowNull()][string]$Value)

    return [string]::IsNullOrWhiteSpace($Value) -or
        $Value -match "(?i)(REPLACE_WITH|placeholder|changeme|to[-_ ]?do|not[-_ ]?run|unknown value)"
}

function Test-EvidenceMatrixServerName {
    param([AllowNull()][string]$Value)

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

function Test-EvidenceTimestamp {
    param(
        [AllowNull()][string]$Value,
        [Parameter(Mandatory)][string]$Label,
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [System.Collections.Generic.List[string]]$Failures
    )

    $parsed = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse($Value, [ref]$parsed)) {
        $Failures.Add("$Label must be an ISO-8601 timestamp.")
        return $null
    }
    if ($parsed -gt [DateTimeOffset]::UtcNow.AddMinutes(5)) {
        $Failures.Add("$Label cannot be future-dated.")
    }
    if ($parsed -lt [DateTimeOffset]::UtcNow.AddDays(-30)) {
        $Failures.Add("$Label must be no more than 30 days old.")
    }
    return $parsed
}

function Resolve-EvidenceRoot {
    param(
        [AllowNull()][string]$Path,
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [System.Collections.Generic.List[string]]$Failures
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        $Failures.Add("Live MatrixRTC acceptance requires an explicit evidence root.")
        return $null
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        $Failures.Add("MatrixRTC evidence root does not exist: $Path")
        return $null
    }
    try {
        $rootItem = Get-Item -LiteralPath $Path -Force
        if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            $Failures.Add("MatrixRTC evidence root cannot be a symbolic link or junction.")
            return $null
        }
        return [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path).Path).TrimEnd(
            [IO.Path]::DirectorySeparatorChar,
            [IO.Path]::AltDirectorySeparatorChar
        )
    } catch {
        $Failures.Add("MatrixRTC evidence root could not be resolved canonically.")
        return $null
    }
}

function Test-EvidencePathHasReparsePoint {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$RelativePath
    )

    $current = $Root
    foreach ($segment in $RelativePath -split "[\\/]") {
        $current = Join-Path $current $segment
        $item = Get-Item -LiteralPath $current -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            return $true
        }
    }
    return $false
}

function Get-GitValue {
    param(
        [Parameter(Mandatory)][string]$SourceRoot,
        [Parameter(Mandatory)][string[]]$Arguments
    )

    try {
        $output = & git -C $SourceRoot @Arguments 2>$null
        if ($LASTEXITCODE -ne 0) {
            return $null
        }
        return ([string]::Join("`n", @($output))).Trim()
    } catch {
        return $null
    }
}

function Test-TextArtifactForSecrets {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$MediaType,
        [Parameter(Mandatory)][string]$ArtifactId,
        [Parameter(Mandatory)][long]$ByteSize,
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [System.Collections.Generic.List[string]]$Failures
    )

    if ($ByteSize -gt 5MB -or
        $MediaType -notmatch "^(?i)(text/|application/(json|xml|yaml|x-yaml))") {
        return
    }

    try {
        $content = Get-Content -LiteralPath $Path -Raw
        $secretPatterns = @(
            "(?i)authorization\s*:\s*bearer\s+\S+",
            "(?i)(access[_-]?token|refresh[_-]?token|jwt|api[_-]?(?:key|secret)|turn[_-]?(?:username|credential))\s*[:=]\s*\S+",
            "(?i)LIVEKIT_API_(?:KEY|SECRET)\s*=\s*\S+",
            "@[A-Za-z0-9._=/+-]+:[A-Za-z0-9.-]+",
            "![A-Za-z0-9._=/+-]+:[A-Za-z0-9.-]+"
        )
        foreach ($pattern in $secretPatterns) {
            if ($content -match $pattern) {
                $Failures.Add("Evidence artifact $ArtifactId contains a forbidden secret or direct Matrix identifier pattern.")
                break
            }
        }
    } catch {
        $Failures.Add("Evidence artifact $ArtifactId could not be scanned for redaction.")
    }
}

function Test-MatrixRtcAcceptanceEvidence {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [string]$EvidenceRoot,
        [string]$SourceRoot,
        [string]$TrackedTemplatePath,
        [switch]$RequireComplete
    )

    $failures = [System.Collections.Generic.List[string]]::new()
    $passes = [System.Collections.Generic.List[string]]::new()

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        $failures.Add("MatrixRTC acceptance evidence does not exist: $Path")
        return [pscustomobject]@{ Failures = @($failures); Passes = @($passes) }
    }

    try {
        $document = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    } catch {
        $failures.Add("MatrixRTC acceptance evidence is not valid JSON.")
        return [pscustomobject]@{ Failures = @($failures); Passes = @($passes) }
    }

    $isTrackedTemplate = $false
    if ($TrackedTemplatePath -and
        (Test-Path -LiteralPath $TrackedTemplatePath -PathType Leaf)) {
        $isTrackedTemplate = [IO.Path]::GetFullPath($Path) -eq
            [IO.Path]::GetFullPath($TrackedTemplatePath)
    }

    if ((Get-EvidenceProperty $document "schemaVersion") -ne 2) {
        $failures.Add("MatrixRTC acceptance evidence must use schemaVersion 2.")
    }

    $stack = Get-EvidenceProperty $document "stack"
    if ((Get-EvidenceProperty $stack "liveKitImage") -ne $script:ExpectedLiveKitImage) {
        $failures.Add("MatrixRTC evidence must identify the reviewed LiveKit image and digest.")
    }
    if ((Get-EvidenceProperty $stack "authorizationImage") -ne
        $script:ExpectedAuthorizationImage) {
        $failures.Add("MatrixRTC evidence must identify the reviewed authorization-service image and digest.")
    }

    $privacy = Get-EvidenceProperty $document "privacy"
    if ((Get-EvidenceProperty $privacy "sanitized") -ne $true -or
        (Get-EvidenceProperty $privacy "containsSecrets") -ne $false) {
        $failures.Add("MatrixRTC evidence must attest that artifacts are sanitized and contain no secrets.")
    }

    $artifacts = @((Get-EvidenceProperty $document "artifacts"))
    $artifactById = @{}
    $artifactPathByCanonicalPath = @{}
    $resolvedEvidenceRoot = $null
    if ($RequireComplete) {
        $resolvedEvidenceRoot = Resolve-EvidenceRoot -Path $EvidenceRoot -Failures $failures
    }

    foreach ($artifact in $artifacts) {
        if ($null -eq $artifact) {
            continue
        }
        $id = [string](Get-EvidenceProperty $artifact "id")
        $kind = [string](Get-EvidenceProperty $artifact "kind")
        $relativePath = [string](Get-EvidenceProperty $artifact "path")
        $sha256 = [string](Get-EvidenceProperty $artifact "sha256")
        $mediaType = [string](Get-EvidenceProperty $artifact "mediaType")
        $description = [string](Get-EvidenceProperty $artifact "description")
        $capturedAt = [string](Get-EvidenceProperty $artifact "capturedAt")
        $caseId = [string](Get-EvidenceProperty $artifact "caseId")
        $byteSizeValue = Get-EvidenceProperty $artifact "byteSize"

        if ($id -notmatch "^[a-z0-9][a-z0-9._-]{2,63}$" -or
            (Test-EvidencePlaceholder $id)) {
            $failures.Add("Every MatrixRTC artifact needs a stable, non-placeholder evidence ID.")
            continue
        }
        if ($artifactById.ContainsKey($id)) {
            $failures.Add("MatrixRTC evidence artifact ID is duplicated: $id")
            continue
        }
        $artifactById[$id] = $artifact

        if ($kind -notin $script:AllowedArtifactKinds) {
            $failures.Add("Evidence artifact $id has unsupported kind '$kind'.")
        }
        if ($mediaType -notmatch "^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*$") {
            $failures.Add("Evidence artifact $id has an invalid media type.")
        }
        if (Test-EvidencePlaceholder $description) {
            $failures.Add("Evidence artifact $id needs a sanitized non-placeholder description.")
        }
        if ($RequireComplete) {
            if ($kind -eq "client-build") {
                if ($caseId) {
                    $failures.Add("Client-build evidence artifact $id must not be assigned to one acceptance case.")
                }
            } elseif ($caseId -notin $script:RequiredMatrixRtcCases) {
                $failures.Add("Evidence artifact $id must bind to one required MatrixRTC caseId.")
            }
        }
        [void](Test-EvidenceTimestamp -Value $capturedAt -Label "Evidence artifact $id capturedAt" -Failures $failures)

        if (-not $RequireComplete) {
            continue
        }

        if ([string]::IsNullOrWhiteSpace($relativePath) -or
            [IO.Path]::IsPathRooted($relativePath) -or
            @($relativePath -split "[\\/]" | Where-Object { $_ -eq ".." }).Count -gt 0) {
            $failures.Add("Evidence artifact $id path must be relative and cannot contain traversal.")
            continue
        }
        if ($null -eq $resolvedEvidenceRoot) {
            continue
        }

        $candidatePath = Join-Path $resolvedEvidenceRoot $relativePath
        if (-not (Test-Path -LiteralPath $candidatePath -PathType Leaf)) {
            $failures.Add("Evidence artifact $id file does not exist below the evidence root.")
            continue
        }
        if (Test-EvidencePathHasReparsePoint `
            -Root $resolvedEvidenceRoot `
            -RelativePath $relativePath) {
            $failures.Add("Evidence artifact $id path cannot contain symbolic links or junctions.")
            continue
        }
        try {
            $canonicalPath = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $candidatePath).Path)
        } catch {
            $failures.Add("Evidence artifact $id path could not be resolved canonically.")
            continue
        }
        $rootPrefix = $resolvedEvidenceRoot + [IO.Path]::DirectorySeparatorChar
        if (-not $canonicalPath.StartsWith(
            $rootPrefix,
            [StringComparison]::OrdinalIgnoreCase
        )) {
            $failures.Add("Evidence artifact $id resolves outside the explicit evidence root.")
            continue
        }
        if ($artifactPathByCanonicalPath.ContainsKey($canonicalPath)) {
            $failures.Add("Evidence artifacts must not assign multiple IDs to the same file: $id")
        } else {
            $artifactPathByCanonicalPath[$canonicalPath] = $id
        }

        $actualSize = (Get-Item -LiteralPath $canonicalPath).Length
        $declaredSize = 0L
        if (-not [long]::TryParse([string]$byteSizeValue, [ref]$declaredSize) -or
            $declaredSize -lt 1 -or $declaredSize -ne $actualSize) {
            $failures.Add("Evidence artifact $id byte size does not match the file.")
        }

        if ($sha256 -notmatch "^[0-9a-fA-F]{64}$") {
            $failures.Add("Evidence artifact $id must declare a SHA-256 digest.")
        } else {
            $actualHash = (Get-FileHash -LiteralPath $canonicalPath -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actualHash -ne $sha256.ToLowerInvariant()) {
                $failures.Add("Evidence artifact $id SHA-256 does not match the file.")
            }
        }
        Test-TextArtifactForSecrets `
            -Path $canonicalPath `
            -MediaType $mediaType `
            -ArtifactId $id `
            -ByteSize $actualSize `
            -Failures $failures
    }

    $results = @((Get-EvidenceProperty $document "results"))
    $resultById = @{}
    $referencedArtifactIds = @{}
    $declaredDeviceIds = @{}
    foreach ($device in @((Get-EvidenceProperty $document "devices"))) {
        $deviceId = [string](Get-EvidenceProperty $device "id")
        if ($deviceId) {
            $declaredDeviceIds[$deviceId] = $true
        }
    }
    $declaredNetworkIds = @{}
    foreach ($network in @((Get-EvidenceProperty $document "networks"))) {
        $networkId = [string](Get-EvidenceProperty $network "id")
        if ($networkId) {
            $declaredNetworkIds[$networkId] = $true
        }
    }
    foreach ($result in $results) {
        if ($null -eq $result) {
            continue
        }
        $id = [string](Get-EvidenceProperty $result "id")
        $status = [string](Get-EvidenceProperty $result "status")
        $expected = [string](Get-EvidenceProperty $result "expected")
        $actual = [string](Get-EvidenceProperty $result "actual")
        $notApplicableReason = [string](Get-EvidenceProperty $result "notApplicableReason")
        $deviceIds = @(
            (Get-EvidenceProperty $result "deviceIds") |
                ForEach-Object { [string]$_ } |
                Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        )
        $networkIds = @(
            (Get-EvidenceProperty $result "networkIds") |
                ForEach-Object { [string]$_ } |
                Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        )
        $transport = [string](Get-EvidenceProperty $result "transport")
        $mediaE2eeActive = Get-EvidenceProperty $result "mediaE2eeActive"
        $mediaE2eeFailureClosed = Get-EvidenceProperty $result "mediaE2eeFailureClosed"
        $evidenceIds = @(
            (Get-EvidenceProperty $result "evidenceIds") |
                ForEach-Object { [string]$_ } |
                Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        )

        if (-not $id) {
            $failures.Add("Every MatrixRTC acceptance result must have an id.")
            continue
        }
        if ($resultById.ContainsKey($id)) {
            $failures.Add("MatrixRTC acceptance result id is duplicated: $id")
            continue
        }
        $resultById[$id] = $result
        if ($id -notin $script:RequiredMatrixRtcCases) {
            $failures.Add("MatrixRTC acceptance evidence contains an unknown result id: $id")
        }
        if ([string]::IsNullOrWhiteSpace($expected)) {
            $failures.Add("MatrixRTC acceptance result $id must state the expected behavior.")
        }
        if ($status -notin @("not-run", "passed", "failed", "blocked", "not-applicable")) {
            $failures.Add("MatrixRTC acceptance result $id has invalid status '$status'.")
        }
        if ($isTrackedTemplate -and $status -ne "not-run") {
            $failures.Add("The tracked MatrixRTC template must not claim a test result: $id is $status.")
        }
        if ($transport -notin $script:AllowedObservedTransports) {
            $failures.Add("MatrixRTC acceptance result $id has invalid transport '$transport'.")
        }
        if ($isTrackedTemplate -and (
            $deviceIds.Count -gt 0 -or
            $networkIds.Count -gt 0 -or
            $transport -ne "not-observed" -or
            $mediaE2eeActive -ne $false -or
            $mediaE2eeFailureClosed -ne $false
        )) {
            $failures.Add("The tracked MatrixRTC template must not contain observed device, network, transport, or media-E2EE claims for $id.")
        }
        if ($status -eq "not-applicable") {
            if ($id -notin $script:NotApplicableMatrixRtcCases) {
                $failures.Add("MatrixRTC acceptance result $id cannot be marked not-applicable.")
            }
            if (Test-EvidencePlaceholder $notApplicableReason) {
                $failures.Add("Not-applicable MatrixRTC result $id requires a non-placeholder reason.")
            }
        } elseif ($notApplicableReason) {
            $failures.Add("MatrixRTC result $id may only include notApplicableReason when status is not-applicable.")
        }

        if ($RequireComplete) {
            if ($status -ne "passed" -and
                -not ($id -in $script:NotApplicableMatrixRtcCases -and
                    $status -eq "not-applicable")) {
                $failures.Add("Live MatrixRTC acceptance is incomplete: $id is $status.")
            }
            if (Test-EvidencePlaceholder $actual) {
                $failures.Add("Completed MatrixRTC result $id needs a non-placeholder actual result.")
            }
            if ($status -eq "passed" -and $evidenceIds.Count -lt 1) {
                $failures.Add("Passed MatrixRTC result $id must reference evidence IDs.")
            }
            if ($status -eq "passed") {
                if ($deviceIds.Count -lt 2) {
                    $failures.Add("Passed MatrixRTC result $id must bind to at least two tested devices.")
                }
                if ($id -eq "three-person-call" -and $deviceIds.Count -lt 3) {
                    $failures.Add("Passed MatrixRTC result three-person-call must bind to at least three tested devices.")
                }
                if ($networkIds.Count -lt 1) {
                    $failures.Add("Passed MatrixRTC result $id must bind to at least one tested network.")
                }
                if ($id -in $script:TwoNetworkMatrixRtcCases -and $networkIds.Count -lt 2) {
                    $failures.Add("Passed MatrixRTC result $id must bind to at least two independent tested networks.")
                }
                if ($transport -eq "not-observed") {
                    $failures.Add("Passed MatrixRTC result $id must record an observed media transport.")
                }
                if ($id -eq "two-windows-same-lan" -and
                    $transport -notin @("direct", "mixed")) {
                    $failures.Add("Passed MatrixRTC result two-windows-same-lan must prove direct media.")
                }
                if ($id -eq "restrictive-nat" -and
                    $transport -notin @("turn-udp", "mixed")) {
                    $failures.Add("Passed MatrixRTC result restrictive-nat must prove TURN-relayed media.")
                }
                if ($id -eq "udp-blocked-turn-tcp-tls" -and
                    $transport -ne "turn-tcp-tls") {
                    $failures.Add("Passed MatrixRTC result udp-blocked-turn-tcp-tls must prove TURN over TCP/TLS.")
                }
                if ($mediaE2eeActive -ne $true) {
                    $failures.Add("Passed MatrixRTC result $id must attest active media E2EE.")
                }
                if ($id -eq "media-key-rotation-late-join" -and
                    $mediaE2eeFailureClosed -ne $true) {
                    $failures.Add("Passed MatrixRTC result media-key-rotation-late-join must attest failure-closed media publication.")
                }
            }
        }

        $seenDeviceIds = @{}
        foreach ($deviceId in $deviceIds) {
            if ($seenDeviceIds.ContainsKey($deviceId)) {
                $failures.Add("MatrixRTC result $id references device ID $deviceId more than once.")
            } else {
                $seenDeviceIds[$deviceId] = $true
            }
            if (-not $declaredDeviceIds.ContainsKey($deviceId)) {
                $failures.Add("MatrixRTC result $id references unknown device ID: $deviceId")
            }
        }
        $seenNetworkIds = @{}
        foreach ($networkId in $networkIds) {
            if ($seenNetworkIds.ContainsKey($networkId)) {
                $failures.Add("MatrixRTC result $id references network ID $networkId more than once.")
            } else {
                $seenNetworkIds[$networkId] = $true
            }
            if (-not $declaredNetworkIds.ContainsKey($networkId)) {
                $failures.Add("MatrixRTC result $id references unknown network ID: $networkId")
            }
        }

        $seenResultRefs = @{}
        foreach ($evidenceId in $evidenceIds) {
            if ($seenResultRefs.ContainsKey($evidenceId)) {
                $failures.Add("MatrixRTC result $id references evidence ID $evidenceId more than once.")
                continue
            }
            $seenResultRefs[$evidenceId] = $true
            $referencedArtifactIds[$evidenceId] = $true
            if (-not $artifactById.ContainsKey($evidenceId)) {
                $failures.Add("MatrixRTC result $id references unknown evidence ID: $evidenceId")
            } else {
                $artifact = $artifactById[$evidenceId]
                $artifactKind = [string](Get-EvidenceProperty $artifact "kind")
                $artifactCaseId = [string](Get-EvidenceProperty $artifact "caseId")
                if ($artifactKind -ne "client-build" -and $artifactCaseId -ne $id) {
                    $failures.Add("MatrixRTC result $id references artifact $evidenceId bound to the wrong caseId.")
                }
            }
        }

        if ($RequireComplete -and $status -eq "passed") {
            $referencedKinds = @(
                $evidenceIds |
                    Where-Object { $artifactById.ContainsKey($_) } |
                    ForEach-Object { [string](Get-EvidenceProperty $artifactById[$_] "kind") }
            )
            if ("service-log" -notin $referencedKinds) {
                $failures.Add("Passed MatrixRTC result $id must reference a service-log artifact.")
            }
            if ("client-diagnostic" -notin $referencedKinds) {
                $failures.Add("Passed MatrixRTC result $id must reference a client-diagnostic artifact.")
            }
            if ("network-result" -notin $referencedKinds) {
                $failures.Add("Passed MatrixRTC result $id must reference a network-result artifact.")
            }
        }
    }

    foreach ($requiredCase in $script:RequiredMatrixRtcCases) {
        if (-not $resultById.ContainsKey($requiredCase)) {
            $failures.Add("MatrixRTC acceptance evidence is missing required result: $requiredCase")
        }
    }
    if ($results.Count -ne $script:RequiredMatrixRtcCases.Count) {
        $failures.Add("MatrixRTC acceptance evidence must contain exactly $($script:RequiredMatrixRtcCases.Count) required results.")
    }

    if ($RequireComplete) {
        if (-not $SourceRoot -or
            -not (Test-Path -LiteralPath $SourceRoot -PathType Container)) {
            $failures.Add("Live MatrixRTC acceptance requires an existing source root.")
        } else {
            $resolvedSourceRoot = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $SourceRoot).Path)
            $gitRoot = Get-GitValue -SourceRoot $resolvedSourceRoot -Arguments @(
                "rev-parse",
                "--show-toplevel"
            )
            if (-not $gitRoot -or
                [IO.Path]::GetFullPath($gitRoot) -ne $resolvedSourceRoot.TrimEnd(
                    [IO.Path]::DirectorySeparatorChar,
                    [IO.Path]::AltDirectorySeparatorChar
                )) {
                $failures.Add("Live MatrixRTC source root must be the exact Git worktree root.")
            }
            if ($resolvedEvidenceRoot) {
                $sourcePrefix = $resolvedSourceRoot.TrimEnd(
                    [IO.Path]::DirectorySeparatorChar,
                    [IO.Path]::AltDirectorySeparatorChar
                ) + [IO.Path]::DirectorySeparatorChar
                if ($resolvedEvidenceRoot -eq $resolvedSourceRoot -or
                    $resolvedEvidenceRoot.StartsWith(
                        $sourcePrefix,
                        [StringComparison]::OrdinalIgnoreCase
                    )) {
                    $relativeEvidenceRoot = if (
                        $resolvedEvidenceRoot -eq $resolvedSourceRoot
                    ) {
                        "."
                    } else {
                        $resolvedEvidenceRoot.Substring($sourcePrefix.Length)
                    }
                    & git -C $resolvedSourceRoot check-ignore -q -- $relativeEvidenceRoot
                    if ($LASTEXITCODE -ne 0) {
                        $failures.Add(
                            "MatrixRTC evidence stored inside the source worktree must be in an explicitly ignored directory."
                        )
                    }
                }
            }
            $currentSha = Get-GitValue -SourceRoot $resolvedSourceRoot -Arguments @(
                "rev-parse",
                "HEAD"
            )
            $sourceSha = [string](Get-EvidenceProperty $document "sourceSha")
            if ($sourceSha -notmatch "^[0-9a-f]{40}$" -or
                -not $currentSha -or $sourceSha -ne $currentSha) {
                $failures.Add("Live MatrixRTC evidence sourceSha must equal the current 40-character Git SHA.")
            }
            $worktreeState = Get-GitValue -SourceRoot $resolvedSourceRoot -Arguments @(
                "status",
                "--porcelain",
                "--untracked-files=all"
            )
            if ($null -eq $worktreeState) {
                $failures.Add("Git is required to verify the MatrixRTC source worktree.")
            } elseif ($worktreeState) {
                $failures.Add("Live MatrixRTC acceptance requires a clean tracked and untracked source worktree.")
            }

            $clientBuild = Get-EvidenceProperty $document "clientBuild"
            $clientBuildIdentifier = [string](Get-EvidenceProperty $clientBuild "identifier")
            $clientBuildSourceSha = [string](Get-EvidenceProperty $clientBuild "sourceSha")
            $clientBuildEvidenceId = [string](Get-EvidenceProperty $clientBuild "artifactEvidenceId")
            if ((Test-EvidencePlaceholder $clientBuildIdentifier) -or
                $clientBuildIdentifier -match "(?i)(NotSigned|unsigned|\b0\.1\.0\b)") {
                $failures.Add("Live MatrixRTC evidence must identify a non-placeholder signed client build.")
            }
            if ($clientBuildSourceSha -ne $sourceSha) {
                $failures.Add("The tested client artifact provenance must bind to evidence sourceSha.")
            }
            if (-not $artifactById.ContainsKey($clientBuildEvidenceId) -or
                (Get-EvidenceProperty $artifactById[$clientBuildEvidenceId] "kind") -ne
                    "client-build") {
                $failures.Add("The tested client build must reference a client-build evidence artifact.")
            } else {
                $referencedArtifactIds[$clientBuildEvidenceId] = $true
            }
        }

        [void](Test-EvidenceTimestamp `
            -Value ([string](Get-EvidenceProperty $document "testedAt")) `
            -Label "Live MatrixRTC evidence testedAt" `
            -Failures $failures)

        $operator = [string](Get-EvidenceProperty $document "operator")
        if (Test-EvidencePlaceholder $operator) {
            $failures.Add("Live MatrixRTC evidence must identify the responsible operator or test role.")
        }

        $homeservers = @(
            (Get-EvidenceProperty $document "homeservers") |
                ForEach-Object { [string]$_ } |
                Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
                Select-Object -Unique
        )
        if ($homeservers.Count -lt 2 -or
            @($homeservers | Where-Object {
                (Test-EvidencePlaceholder $_) -or
                -not (Test-EvidenceMatrixServerName $_)
            }).Count -gt 0) {
            $failures.Add("Live MatrixRTC evidence must identify at least two independently addressed homeservers.")
        }

        $services = Get-EvidenceProperty $document "services"
        foreach ($serviceField in @(
            @{ Name = "authorizationEndpoint"; Scheme = "https" },
            @{ Name = "sfuEndpoint"; Scheme = "wss" },
            @{ Name = "turnEndpoint"; Scheme = "turns" }
        )) {
            $value = [string](Get-EvidenceProperty $services $serviceField.Name)
            $parsed = $null
            if ((Test-EvidencePlaceholder $value) -or
                -not [Uri]::TryCreate($value, [UriKind]::Absolute, [ref]$parsed) -or
                $parsed.Scheme -ne $serviceField.Scheme -or $parsed.UserInfo) {
                $failures.Add("Live MatrixRTC evidence field services.$($serviceField.Name) must be a sanitized $($serviceField.Scheme) endpoint.")
            }
        }

        foreach ($collectionName in @("devices", "networks")) {
            $entries = @((Get-EvidenceProperty $document $collectionName))
            $uniqueIds = @{}
            if ($entries.Count -lt 2) {
                $failures.Add("Live MatrixRTC evidence must identify at least two non-placeholder $collectionName.")
            }
            foreach ($entry in $entries) {
                if ($null -eq $entry) {
                    continue
                }
                $entryId = [string](Get-EvidenceProperty $entry "id")
                $description = [string](Get-EvidenceProperty $entry "description")
                if ((Test-EvidencePlaceholder $entryId) -or
                    (Test-EvidencePlaceholder $description)) {
                    $failures.Add("Live MatrixRTC evidence contains a placeholder $collectionName entry.")
                } elseif ($uniqueIds.ContainsKey($entryId)) {
                    $failures.Add("Live MatrixRTC evidence contains duplicate $collectionName id: $entryId")
                } else {
                    $uniqueIds[$entryId] = $true
                }
                if ($collectionName -eq "devices" -and
                    (Test-EvidencePlaceholder (
                        [string](Get-EvidenceProperty $entry "platform")
                    ))) {
                    $failures.Add("Live MatrixRTC evidence contains a device without a real platform.")
                }
            }
        }

        foreach ($artifactId in $artifactById.Keys) {
            if (-not $referencedArtifactIds.ContainsKey($artifactId)) {
                $failures.Add("Evidence artifact is not referenced by a result or client build: $artifactId")
            }
        }
    }

    if ($failures.Count -eq 0) {
        if ($RequireComplete) {
            $passes.Add("MatrixRTC live evidence is clean-source-bound, tamper-evident, current, complete, and artifact-verified.")
        } elseif ($isTrackedTemplate) {
            $passes.Add("MatrixRTC acceptance template is structurally complete and makes no live claim.")
        } else {
            $passes.Add("MatrixRTC evidence is structurally valid; live completeness was not requested.")
        }
    }

    return [pscustomobject]@{
        Failures = @($failures)
        Passes = @($passes)
    }
}

Export-ModuleMember -Function Test-MatrixRtcAcceptanceEvidence
