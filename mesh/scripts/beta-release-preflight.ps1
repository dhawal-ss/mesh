[CmdletBinding()]
param(
    [string]$Tag = "",
    [string]$ReleaseVersion = "",
    [switch]$ValidationOnly,
    [switch]$RequireCleanSource,
    [string]$ExpectedSourceSha = "",
    [switch]$RequireProtectedMainAncestry,
    [string]$ProtectedMainRef = "refs/remotes/origin/main",
    [switch]$RequireSigningEnvironment,
    [switch]$VerifyFrontendBundle,
    [string]$FrontendRoot = "",
    [switch]$VerifyArtifacts,
    [string]$BundleRoot = "",
    [string]$ChecksumOutput = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$gitRoot = Split-Path -Parent $repoRoot
$tauriRoot = Join-Path $repoRoot "src-tauri"

function Assert-Condition {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

if ($ValidationOnly) {
    Assert-Condition ([string]::IsNullOrWhiteSpace($Tag)) `
        "Validation-only preflight cannot name a release tag."
    Assert-Condition (-not $RequireCleanSource -and -not $RequireProtectedMainAncestry -and
        -not $RequireSigningEnvironment -and -not $VerifyArtifacts) `
        "Validation-only preflight cannot request candidate, signing, or artifact verification."
}

function Read-JsonFile {
    param([string]$Path)

    Assert-Condition (Test-Path -LiteralPath $Path -PathType Leaf) "Required file is missing: $Path"
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Read-Utf8Text {
    param([string]$Path)

    Assert-Condition (Test-Path -LiteralPath $Path -PathType Leaf) "Required file is missing: $Path"
    return Get-Content -LiteralPath $Path -Raw
}

function Get-CargoPackageVersion {
    param([string]$CargoText)

    $packageSection = [regex]::Match(
        $CargoText,
        '(?ms)^\[package\]\s*(?<body>.*?)(?=^\[|\z)'
    )
    Assert-Condition $packageSection.Success "Cargo.toml does not contain a [package] section."

    $versionMatch = [regex]::Match(
        $packageSection.Groups["body"].Value,
        '(?m)^\s*version\s*=\s*"(?<version>[^"]+)"\s*$'
    )
    Assert-Condition $versionMatch.Success "Cargo.toml [package] does not declare a version."
    return $versionMatch.Groups["version"].Value
}

function Assert-NoUpdaterConfiguration {
    param(
        [object]$TauriConfig,
        [object]$PackageConfig,
        [string]$CargoText,
        [string]$CapabilitiesText,
        [string]$ReleaseWorkflowText
    )

    $tauriJson = $TauriConfig | ConvertTo-Json -Depth 100 -Compress
    Assert-Condition ($tauriJson -notmatch '(?i)"updater"') `
        "Tauri updater configuration is present. Do not enable it until signed update endpoints and a public key are provisioned."
    Assert-Condition (-not ($PackageConfig.dependencies.PSObject.Properties.Name -contains "@tauri-apps/plugin-updater")) `
        "The JavaScript updater plugin is installed without an approved signed-update configuration."
    Assert-Condition ($CargoText -notmatch '(?m)^\s*tauri-plugin-updater\s*=') `
        "The Rust updater plugin is installed without an approved signed-update configuration."
    Assert-Condition ($CapabilitiesText -notmatch '(?i)updater:') `
        "An updater capability is enabled without an approved signed-update configuration."
    Assert-Condition ($ReleaseWorkflowText -notmatch '(?i)uploadUpdaterJson:\s*true') `
        "The beta workflow must not emit updater JSON until signed updater infrastructure is configured."
    Assert-Condition ($ReleaseWorkflowText -notmatch '(?i)latest\.json') `
        "The beta workflow must not emit an updater manifest until signed updater infrastructure is configured."
}

function Assert-PinnedActions {
    param(
        [string]$WorkflowName,
        [string]$WorkflowText
    )

    $usesLines = [regex]::Matches(
        $WorkflowText,
        '(?m)^\s*(?:-\s+)?uses:\s*(?<action>[^\s#]+)'
    )
    Assert-Condition ($usesLines.Count -gt 0) "$WorkflowName does not declare any actions to validate."
    foreach ($usesLine in $usesLines) {
        $action = $usesLine.Groups["action"].Value
        Assert-Condition ($action -match '@[0-9a-fA-F]{40}$') `
            "$WorkflowName contains an action that is not pinned to a full commit SHA: $action"
    }
}

function Resolve-RepoChildPath {
    param(
        [string]$Path,
        [string]$DefaultPath,
        [string]$Description
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        $Path = $DefaultPath
    } elseif (-not [IO.Path]::IsPathRooted($Path)) {
        $Path = Join-Path $repoRoot $Path
    }

    Assert-Condition (Test-Path -LiteralPath $Path -PathType Container) `
        "$Description does not exist: $Path"

    $resolvedPath = (Resolve-Path -LiteralPath $Path).Path
    $resolvedRepoRoot = (Resolve-Path -LiteralPath $repoRoot).Path
    $repoPrefix = $resolvedRepoRoot.TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar
    ) + [IO.Path]::DirectorySeparatorChar
    Assert-Condition ($resolvedPath.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase)) `
        "$Description must be inside the Mesh repository."
    return $resolvedPath
}

function Get-LocalAssetPath {
    param(
        [string]$Root,
        [string]$AssetReference,
        [string]$Description
    )

    $reference = $AssetReference.Split("?", 2)[0].Split("#", 2)[0]
    Assert-Condition ($reference -notmatch '^(?i:https?:)?//') `
        "$Description must not load JavaScript from an external origin: $AssetReference"

    $relative = $reference.TrimStart("/", "\").Replace("/", [IO.Path]::DirectorySeparatorChar)
    $candidate = [IO.Path]::GetFullPath((Join-Path $Root $relative))
    $rootPrefix = $Root.TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar
    ) + [IO.Path]::DirectorySeparatorChar
    Assert-Condition ($candidate.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) `
        "$Description escapes the frontend bundle root: $AssetReference"
    Assert-Condition (Test-Path -LiteralPath $candidate -PathType Leaf) `
        "$Description is missing from the frontend bundle: $AssetReference"
    return $candidate
}

function Get-StaticJavaScriptImports {
    param([string]$JavaScript)

    $references = [System.Collections.Generic.HashSet[string]]::new(
        [StringComparer]::Ordinal
    )
    $patterns = @(
        '(?ms)(?:^|[;\r\n])\s*import\s*(?!\()\s*(?:(?:[^"'';]+?)\s+from\s*)?["''](?<path>\.?/[^"'']+\.js)["'']',
        '(?ms)(?:^|[;\r\n])\s*export\s+[^;"'']+?\s+from\s*["''](?<path>\.?/[^"'']+\.js)["'']'
    )
    foreach ($pattern in $patterns) {
        foreach ($match in [regex]::Matches($JavaScript, $pattern)) {
            $references.Add($match.Groups["path"].Value) | Out-Null
        }
    }
    return @($references)
}

function Test-SimplePeerImplementation {
    param([string]$JavaScript)

    $implementationMarkers = @(
        'No WebRTC support: Not a supported browser',
        'allowHalfTrickle',
        'iceCompleteTimeout',
        'RTCPeerConnection:globalThis.RTCPeerConnection'
    )
    $matches = @(
        $implementationMarkers |
            Where-Object {
                $JavaScript.IndexOf($_, [StringComparison]::Ordinal) -ge 0
            }
    )
    return $matches.Count -ge 3
}

function Assert-MatrixFrontendBundleBoundary {
    param([string]$Root)

    $indexPath = Join-Path $Root "index.html"
    Assert-Condition (Test-Path -LiteralPath $indexPath -PathType Leaf) `
        "Frontend bundle is missing index.html: $indexPath"
    $indexText = Read-Utf8Text $indexPath

    $entryReferences = @(
        [regex]::Matches(
            $indexText,
            '(?is)<script\b(?=[^>]*\btype=["'']module["''])[^>]*\bsrc=["''](?<path>[^"'']+\.js(?:[?#][^"'']*)?)["''][^>]*>'
        ) |
            ForEach-Object { $_.Groups["path"].Value }
    )
    Assert-Condition ($entryReferences.Count -eq 1) `
        "Frontend index must declare exactly one local module entry script."

    $preloadReferences = @(
        [regex]::Matches(
            $indexText,
            '(?is)<link\b(?=[^>]*\brel=["'']modulepreload["''])[^>]*\bhref=["''](?<path>[^"'']+\.js(?:[?#][^"'']*)?)["''][^>]*>'
        ) |
            ForEach-Object { $_.Groups["path"].Value }
    )

    $entryPath = Get-LocalAssetPath $Root $entryReferences[0] "Frontend module entry"
    $eagerAssets = [System.Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )
    $pendingAssets = [System.Collections.Generic.Queue[string]]::new()
    $pendingAssets.Enqueue($entryPath)
    foreach ($reference in $preloadReferences) {
        $pendingAssets.Enqueue(
            (Get-LocalAssetPath $Root $reference "Frontend module preload")
        )
    }

    while ($pendingAssets.Count -gt 0) {
        $assetPath = $pendingAssets.Dequeue()
        if (-not $eagerAssets.Add($assetPath)) {
            continue
        }

        $assetText = Read-Utf8Text $assetPath
        Assert-Condition (-not (Test-SimplePeerImplementation $assetText)) `
            "Matrix frontend eagerly loads the legacy SimplePeer implementation: $assetPath"

        foreach ($reference in Get-StaticJavaScriptImports $assetText) {
            $resolvedReference = [IO.Path]::GetFullPath(
                (Join-Path (Split-Path -Parent $assetPath) $reference)
            )
            $rootPrefix = $Root.TrimEnd(
                [IO.Path]::DirectorySeparatorChar,
                [IO.Path]::AltDirectorySeparatorChar
            ) + [IO.Path]::DirectorySeparatorChar
            Assert-Condition ($resolvedReference.StartsWith(
                $rootPrefix,
                [StringComparison]::OrdinalIgnoreCase
            )) "Static frontend import escapes the bundle root: $reference"
            Assert-Condition (Test-Path -LiteralPath $resolvedReference -PathType Leaf) `
                "Static frontend import is missing from the bundle: $reference"
            $pendingAssets.Enqueue($resolvedReference)
        }
    }

    $entryText = Read-Utf8Text $entryPath
    foreach ($marker in @(
        'kind==="legacy-p2p"',
        'capabilities.voice',
        'voiceService.provider==="legacy-simple-peer"',
        'voiceService.availability==="ready"',
        'Matrix production requires MatrixRTC and never falls back to legacy SimplePeer'
    )) {
        Assert-Condition ($entryText.IndexOf($marker, [StringComparison]::Ordinal) -ge 0) `
            "Matrix frontend entry is missing the fail-closed legacy voice boundary marker: $marker"
    }

    $legacyChunks = @(
        Get-ChildItem -LiteralPath $Root -Recurse -File -Filter "*.js" |
            Where-Object {
                Test-SimplePeerImplementation (Read-Utf8Text $_.FullName)
            }
    )
    $legacyChunkNames = @($legacyChunks | ForEach-Object { $_.Name }) -join ", "
    Assert-Condition ($legacyChunks.Count -eq 0) `
        "Matrix frontend bundle must exclude the legacy SimplePeer implementation entirely; found: $legacyChunkNames"

    $liveKitVoiceChunks = @(
        Get-ChildItem -LiteralPath $Root -Recurse -File |
            Where-Object { $_.Name -match '(?i)^livekit-voice-.+\.js$' }
    )
    $e2eeWorkerChunks = @(
        Get-ChildItem -LiteralPath $Root -Recurse -File |
            Where-Object { $_.Name -match '(?i)^livekit-client\.e2ee\.worker-.+\.mjs$' }
    )
    Assert-Condition ($liveKitVoiceChunks.Count -eq 1) `
        "The signed beta candidate must contain exactly one lazy Matrix voice implementation chunk."
    Assert-Condition ($e2eeWorkerChunks.Count -eq 1) `
        "The signed beta candidate must contain exactly one bundled LiveKit media-E2EE worker."

    Write-Host "Frontend boundary: the beta bundle includes Matrix voice and media E2EE while excluding SimplePeer."
}

$packagePath = Join-Path $repoRoot "package.json"
$cargoPath = Join-Path $tauriRoot "Cargo.toml"
$tauriConfigPath = Join-Path $tauriRoot "tauri.conf.json"
$windowsTauriConfigPath = Join-Path $tauriRoot "tauri.windows.conf.json"
$macosTauriConfigPath = Join-Path $tauriRoot "tauri.macos.conf.json"
$linuxTauriConfigPath = Join-Path $tauriRoot "tauri.linux.conf.json"
$matrixVoiceTauriConfigPath = Join-Path $tauriRoot "tauri.matrix-voice.conf.json"
$matrixVoiceTauriRunnerPath = Join-Path $repoRoot "scripts/run-matrix-voice-tauri.mjs"
$unsignedMatrixTauriRunnerPath = Join-Path $repoRoot "scripts/run-unsigned-matrix-tauri.mjs"
$capabilitiesPath = Join-Path $tauriRoot "capabilities/default.json"
$legacyCapabilitiesPath = Join-Path $tauriRoot "capabilities/legacy.json"
$applicationPermissionPath = Join-Path $tauriRoot "permissions/mesh-main.toml"
$legacyPermissionPath = Join-Path $tauriRoot "permissions/mesh-legacy.toml"
$tauriBuildPath = Join-Path $tauriRoot "build.rs"
$nestedWorkflowRoot = Join-Path $repoRoot ".github/workflows"
$ciWorkflowPath = Join-Path $gitRoot ".github/workflows/ci.yml"
$nightlyWorkflowPath = Join-Path $gitRoot ".github/workflows/nightly-soak.yml"
$releaseWorkflowPath = Join-Path $gitRoot ".github/workflows/release-beta.yml"
$securityWorkflowPath = Join-Path $gitRoot ".github/workflows/security.yml"
$r3SecurityWorkflowPath = Join-Path $gitRoot ".github/workflows/security-r3-voice.yml"
$matrixAcceptanceWorkflowPath = Join-Path $gitRoot ".github/workflows/matrix-federation-acceptance.yml"
$developerPreviewWorkflowPath = Join-Path $gitRoot ".github/workflows/developer-preview.yml"
$pagesWorkflowPath = Join-Path $gitRoot ".github/workflows/pages.yml"
$matrixSpikeComposePath = Join-Path $repoRoot "infra/matrix-spike/docker-compose.yml"
$matrixRtcPreflightPath = Join-Path $repoRoot "scripts/matrixrtc-preflight.ps1"
$matrixRtcEvidenceModulePath = Join-Path $repoRoot "infra/matrixrtc/MatrixRtcEvidence.psm1"
$matrixRtcEvidenceTestPath = Join-Path $repoRoot "infra/matrixrtc/test-evidence-validation.ps1"
$matrixDependencyBoundaryPath = Join-Path $repoRoot "scripts/check-matrix-release-dependencies.ps1"
$releaseArtifactScanPath = Join-Path $repoRoot "scripts/scan-release-artifacts.ps1"
$resourceProbePath = Join-Path $repoRoot "scripts/resource-budget-probe.ps1"
$installedStartupProbePath = Join-Path $repoRoot "scripts/installed-startup-probe.ps1"
$messageLatencyProbePath = Join-Path $repoRoot "scripts/message-latency-probe.ps1"
$largeTimelineSpecPath = Join-Path $repoRoot "e2e/large-timeline-performance.spec.ts"
$windowsAcceptanceRunbookPath = Join-Path $repoRoot "infra/windows-acceptance/PERFORMANCE_AND_ACCESSIBILITY_RUNBOOK.rst"
$windowsAccessibilityChecklistPath = Join-Path $repoRoot "infra/windows-acceptance/accessibility-checklist.example.json"
$viteConfigPath = Join-Path $repoRoot "vite.config.ts"
$rendererEntryPath = Join-Path $repoRoot "src/main.tsx"
$disabledPreviewRuntimePath = Join-Path $repoRoot "src/dev/installWorkspacePreview.disabled.ts"
$disabledPreviewStatePath = Join-Path $repoRoot "src/dev/WorkspacePreviewState.disabled.tsx"
$rustDependencyPolicyPath = Join-Path $repoRoot "scripts/rust-dependency-policy.json"
$cargoDenyPath = Join-Path $tauriRoot "deny.toml"
$operatorSmokePath = Join-Path $repoRoot "scripts/operator-smoke.ps1"
$operationsContractCheckerPath = Join-Path $repoRoot "scripts/check-operations-contract.mjs"
$dependabotPath = Join-Path $gitRoot ".github/dependabot.yml"
$dependencyReviewConfigPath = Join-Path $gitRoot ".github/dependency-review-config.yml"
$codeownersPath = Join-Path $gitRoot ".github/CODEOWNERS"
$securityPolicyPath = Join-Path $gitRoot "SECURITY.md"
$licensePolicyPath = Join-Path $gitRoot "LICENSE_POLICY.md"
$securityDisclosureDrillPath = Join-Path $repoRoot "scripts/security-disclosure-drill.mjs"

$packageConfig = Read-JsonFile $packagePath
$tauriConfig = Read-JsonFile $tauriConfigPath
$platformTauriConfigs = @{
    "windows" = Read-JsonFile $windowsTauriConfigPath
    "macos"   = Read-JsonFile $macosTauriConfigPath
    "linux"   = Read-JsonFile $linuxTauriConfigPath
}
$matrixVoiceTauriConfigText = Read-Utf8Text $matrixVoiceTauriConfigPath
$matrixVoiceTauriRunnerText = Read-Utf8Text $matrixVoiceTauriRunnerPath
$unsignedMatrixTauriRunnerText = Read-Utf8Text $unsignedMatrixTauriRunnerPath
$cargoText = Read-Utf8Text $cargoPath
$capabilitiesText = Read-Utf8Text $capabilitiesPath
$legacyCapabilitiesText = Read-Utf8Text $legacyCapabilitiesPath
$applicationPermissionText = Read-Utf8Text $applicationPermissionPath
$legacyPermissionText = Read-Utf8Text $legacyPermissionPath
$tauriBuildText = Read-Utf8Text $tauriBuildPath
$ciWorkflowText = Read-Utf8Text $ciWorkflowPath
$nightlyWorkflowText = Read-Utf8Text $nightlyWorkflowPath
$releaseWorkflowText = Read-Utf8Text $releaseWorkflowPath
$securityWorkflowText = Read-Utf8Text $securityWorkflowPath
$r3SecurityWorkflowText = Read-Utf8Text $r3SecurityWorkflowPath
$matrixAcceptanceWorkflowText = Read-Utf8Text $matrixAcceptanceWorkflowPath
$developerPreviewWorkflowText = Read-Utf8Text $developerPreviewWorkflowPath
$pagesWorkflowText = Read-Utf8Text $pagesWorkflowPath
$matrixSpikeComposeText = Read-Utf8Text $matrixSpikeComposePath
$matrixRtcPreflightText = Read-Utf8Text $matrixRtcPreflightPath
$matrixRtcEvidenceModuleText = Read-Utf8Text $matrixRtcEvidenceModulePath
$matrixRtcEvidenceTestText = Read-Utf8Text $matrixRtcEvidenceTestPath
$matrixDependencyBoundaryText = Read-Utf8Text $matrixDependencyBoundaryPath
$releaseArtifactScanText = Read-Utf8Text $releaseArtifactScanPath
$resourceProbeText = Read-Utf8Text $resourceProbePath
$installedStartupProbeText = Read-Utf8Text $installedStartupProbePath
$messageLatencyProbeText = Read-Utf8Text $messageLatencyProbePath
$largeTimelineSpecText = Read-Utf8Text $largeTimelineSpecPath
$windowsAcceptanceRunbookText = Read-Utf8Text $windowsAcceptanceRunbookPath
$windowsAccessibilityChecklist = Read-JsonFile $windowsAccessibilityChecklistPath
$viteConfigText = Read-Utf8Text $viteConfigPath
$rendererEntryText = Read-Utf8Text $rendererEntryPath
$disabledPreviewRuntimeText = Read-Utf8Text $disabledPreviewRuntimePath
$disabledPreviewStateText = Read-Utf8Text $disabledPreviewStatePath
$rustDependencyPolicyText = Read-Utf8Text $rustDependencyPolicyPath
$cargoDenyText = Read-Utf8Text $cargoDenyPath
$operatorSmokeText = Read-Utf8Text $operatorSmokePath
$operationsContractCheckerText = Read-Utf8Text $operationsContractCheckerPath
$dependabotText = Read-Utf8Text $dependabotPath
$dependencyReviewConfigText = Read-Utf8Text $dependencyReviewConfigPath
$codeownersText = Read-Utf8Text $codeownersPath
$securityPolicyText = Read-Utf8Text $securityPolicyPath
$licensePolicyText = Read-Utf8Text $licensePolicyPath

if (Test-Path -LiteralPath $nestedWorkflowRoot -PathType Container) {
    $nestedWorkflows = @(
        Get-ChildItem -LiteralPath $nestedWorkflowRoot -File |
            Where-Object { $_.Extension -in @(".yml", ".yaml") }
    )
    Assert-Condition ($nestedWorkflows.Count -eq 0) `
        "GitHub workflows must live at the repository root, not under mesh/.github/workflows."
}

$packageVersion = [string]$packageConfig.version
$tauriVersion = [string]$tauriConfig.version
$cargoVersion = Get-CargoPackageVersion $cargoText

Assert-Condition ($packageVersion -eq $tauriVersion) `
    "Version mismatch: package.json is $packageVersion but tauri.conf.json is $tauriVersion."
Assert-Condition ($cargoVersion -eq $tauriVersion) `
    "Version mismatch: Cargo.toml is $cargoVersion but tauri.conf.json is $tauriVersion."
if (-not [string]::IsNullOrWhiteSpace($ReleaseVersion)) {
    $normalizedReleaseVersion = $ReleaseVersion.Trim()
    if ($normalizedReleaseVersion.StartsWith("v", [StringComparison]::OrdinalIgnoreCase)) {
        $normalizedReleaseVersion = $normalizedReleaseVersion.Substring(1)
    }
    Assert-Condition ($normalizedReleaseVersion -match '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$') `
        "ReleaseVersion must be an explicit semantic version."
    Assert-Condition ($normalizedReleaseVersion -eq $tauriVersion) `
        "ReleaseVersion $normalizedReleaseVersion does not match the application version $tauriVersion."
    Assert-Condition ($normalizedReleaseVersion -ne "0.1.0" -or $ValidationOnly) `
        "Version 0.1.0 is a placeholder and is allowed only in explicit validation-only preflight."
}
Assert-Condition ($tauriConfig.identifier -eq "com.mesh.desktop") `
    "The production application identifier must remain com.mesh.desktop."
Assert-Condition ($tauriConfig.productName -eq "Mesh" -and
    [bool]$tauriConfig.app.windows[0].contentProtected) `
    "The production desktop window must keep the Mesh identity and OS content protection enabled."
$baseCsp = [string]$tauriConfig.app.security.csp
foreach ($directive in @("object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'")) {
    Assert-Condition ($baseCsp -match [regex]::Escape($directive)) `
        "The base desktop CSP must contain $directive."
}
Assert-Condition ($baseCsp -notmatch "script-src[^;]*'unsafe-inline'") `
    "The base desktop CSP must never permit inline scripts."
Assert-Condition ($capabilitiesText -match '"mesh-main"' -and
    $applicationPermissionText -match 'identifier\s*=\s*"mesh-main"' -and
    $applicationPermissionText -match 'commands\.allow' -and
    $legacyCapabilitiesText -match '"mesh-legacy"' -and
    $legacyPermissionText -match 'identifier\s*=\s*"mesh-legacy"' -and
    $legacyPermissionText -match 'commands\.allow' -and
    $tauriBuildText -match 'AppManifest::new\(\)\.commands\(application_commands\(\)\)' -and
    $tauriBuildText -match 'include_str!\("permissions/mesh-main\.toml"\)' -and
    $tauriBuildText -match 'include_str!\("permissions/mesh-legacy\.toml"\)') `
    "Tauri application commands must remain behind reviewed per-build renderer permissions."

$defaultFeatures = [regex]::Match(
    $cargoText,
    '(?m)^\s*default\s*=\s*\[\s*"matrix-backend"\s*\]\s*$'
)
Assert-Condition $defaultFeatures.Success `
    "Cargo defaults must remain the safe non-voice Matrix backend; signed voice builds must opt in explicitly."
Assert-Condition ($releaseWorkflowText -match '(?m)^\s*gh release create .+$') `
    "The beta workflow must create its release only after local artifact verification."
Assert-Condition ($releaseWorkflowText -match '(?m)^\s*--draft\s*`?\s*$') `
    "The beta workflow must create a draft release so evidence can be reviewed before publication."
Assert-Condition ($releaseWorkflowText -match '(?m)^\s*--prerelease\s*`?\s*$') `
    "The beta workflow must mark releases as prereleases."
Assert-Condition ($releaseWorkflowText -notmatch 'gh release edit' -and
    $releaseWorkflowText -notmatch '--draft[=:]false' -and
    $releaseWorkflowText -match 'Candidate factory only') `
    "The candidate workflow must contain no public promotion path."
Assert-Condition ($releaseWorkflowText -match 'npm run tauri:build:matrix-voice') `
    "The beta workflow must build the locked Matrix voice feature set."
Assert-Condition ($matrixVoiceTauriConfigText -match "connect-src ipc: http://ipc\.localhost" -and
    $matrixVoiceTauriConfigText -match 'https://livekit-jwt\.call\.matrix\.org' -and
    $matrixVoiceTauriConfigText -match 'wss://livekit-jwt\.call\.matrix\.org' -and
    $matrixVoiceTauriConfigText -match 'https://rtc\.matrix\.tchncs\.de' -and
    $matrixVoiceTauriConfigText -match 'wss://rtc\.matrix\.tchncs\.de' -and
    $matrixVoiceTauriConfigText -match 'https://livekit\.quassel\.io' -and
    $matrixVoiceTauriConfigText -match 'wss://livekit\.quassel\.io' -and
    $matrixVoiceTauriConfigText -notmatch 'wss://\*\.' -and
    $matrixVoiceTauriConfigText -notmatch 'connect-src[^;]*(?:https:|wss:)\s*(?:;|$)') `
    "The isolated Matrix voice config must allow only reviewed zero-cost LiveKit HTTPS/WSS origins, never broad https: or wss:."
foreach ($directive in @("object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'")) {
    Assert-Condition ($matrixVoiceTauriConfigText -match [regex]::Escape($directive)) `
        "The Matrix voice CSP must contain $directive."
}
Assert-Condition ($matrixVoiceTauriConfigText -notmatch "script-src[^;]*'unsafe-inline'" -and
    $securityPolicyText -match "style-src 'unsafe-inline'" -and
    $securityPolicyText -match 'must not be broadened to `script-src`') `
    "Inline scripts must stay blocked, and the residual inline-style exception must remain documented."
Assert-Condition ($matrixVoiceTauriRunnerText -match 'tauri\.matrix-voice\.conf\.json' -and
    $matrixVoiceTauriRunnerText -match "'matrix-voice'" -and
    $matrixVoiceTauriRunnerText -match "MESH_MATRIX_VOICE_FRONTEND: 'matrix-voice'" -and
    $matrixVoiceTauriRunnerText -match "'--locked'" -and
    $matrixVoiceTauriRunnerText -match "'--jobs', '1'") `
    "The native Matrix voice build must combine the reviewed CSP, Rust matrix-voice feature, matrix-voice frontend mode, lockfile, and serialized Cargo build."
Assert-Condition ($packageConfig.scripts.'tauri:build:matrix' -eq 'node scripts/run-unsigned-matrix-tauri.mjs' -and
    $unsignedMatrixTauriRunnerText -match 'UNSIGNED LOCAL BUILD - NOT A RELEASE CANDIDATE' -and
    $unsignedMatrixTauriRunnerText -match 'text-only Matrix developer preview' -and
    $unsignedMatrixTauriRunnerText -match "'--no-default-features'" -and
    $unsignedMatrixTauriRunnerText -match "'--locked'" -and
    $unsignedMatrixTauriRunnerText -match "'--jobs',\s*'1'") `
    "The generic Matrix Tauri build must be locked, serialized, and unmistakably labeled as an unsigned text-only developer preview."
Assert-Condition ($releaseWorkflowText -match '(?m)^\s*release_version:\s*$') `
    "The beta workflow must require an explicit release_version input for manual runs."
Assert-Condition ($releaseWorkflowText -match '(?m)^\s*release_tag:\s*$') `
    "The beta workflow must expose an optional explicit tag for manual publication."
Assert-Condition ($releaseWorkflowText -match 'ReleaseVersion') `
    "The beta workflow must pass its explicit version to source preflight."
Assert-Condition ($releaseWorkflowText -match 'MESH_OAUTH_CLIENT_REGISTRATIONS_JSON:\s*\$\{\{\s*vars\.MESH_OAUTH_CLIENT_REGISTRATIONS_JSON\s*\}\}') `
    "The beta workflow must pass the reviewed public issuer registration registry as a build input."
Assert-Condition ($releaseWorkflowText -notmatch 'MESH_OAUTH_CLIENT_ID') `
    "The beta workflow must not use one global OAuth client ID across unrelated issuers."

Assert-NoUpdaterConfiguration `
    -TauriConfig $tauriConfig `
    -PackageConfig $packageConfig `
    -CargoText $cargoText `
    -CapabilitiesText $capabilitiesText `
    -ReleaseWorkflowText $releaseWorkflowText
Assert-PinnedActions -WorkflowName "ci.yml" -WorkflowText $ciWorkflowText
Assert-PinnedActions -WorkflowName "nightly-soak.yml" -WorkflowText $nightlyWorkflowText
Assert-PinnedActions -WorkflowName "release-beta.yml" -WorkflowText $releaseWorkflowText
Assert-PinnedActions -WorkflowName "security.yml" -WorkflowText $securityWorkflowText
Assert-PinnedActions -WorkflowName "security-r3-voice.yml" -WorkflowText $r3SecurityWorkflowText
Assert-PinnedActions `
    -WorkflowName "matrix-federation-acceptance.yml" `
    -WorkflowText $matrixAcceptanceWorkflowText
Assert-PinnedActions `
    -WorkflowName "developer-preview.yml" `
    -WorkflowText $developerPreviewWorkflowText
Assert-PinnedActions -WorkflowName "pages.yml" -WorkflowText $pagesWorkflowText

Assert-Condition ($releaseWorkflowText -match 'git merge-base --is-ancestor') `
    "The beta workflow must prove that a release tag is contained in protected origin/main."
Assert-Condition ($releaseWorkflowText -match "needs\.quality-gate\.outputs\.create_candidate == 'true'") `
    "Manual release workflow runs must remain validation-only unless a proper tag was validated."
Assert-Condition ($releaseWorkflowText -match '(?m)^\s*environment:\s*matrix-beta\s*$') `
    "Release publication must remain bound to the protected matrix-beta environment."
Assert-Condition ($releaseWorkflowText -match 'actions/download-artifact@[0-9a-fA-F]{40}') `
    "The signing job must consume the exact-source quality evidence artifact."
Assert-Condition ($releaseWorkflowText -match 'path:\s*\$\{\{ runner\.temp \}\}/matrix-beta-quality' -and
    $releaseWorkflowText -match 'Verify and import exact-source quality evidence' -and
    $releaseWorkflowText -match '\$bundle\.sourceSha -ne \$env:MESH_SOURCE_SHA' -and
    $releaseWorkflowText -match '\$dependency\.sourceSha -ne \$env:MESH_SOURCE_SHA' -and
    $releaseWorkflowText -match 'cargoLockSha256 -ne \$lockSha' -and
    $releaseWorkflowText -match 'policySha256 -ne \$policySha') `
    "Downloaded quality evidence must stay outside the checkout until clean-source validation and exact-SHA verification pass."

Assert-Condition ($releaseWorkflowText -match 'npm run check:public-services') `
    "The beta workflow must validate the reviewed public-service catalog."
Assert-Condition ($releaseWorkflowText -match 'npm run check:public-site') `
    "The beta workflow must validate the public site source."
Assert-Condition ($releaseWorkflowText -match 'npm run check:operations-contract' -and
    $ciWorkflowText -match 'npm run check:operations-contract' -and
    $operationsContractCheckerText -match 'crash_report\.rs' -and
    $operationsContractCheckerText -match 'sync-performance-decision\.rst') `
    "CI and release workflows must validate the privacy, incident, trust and safety, sync, and Synapse operations contract."
Assert-Condition ($releaseWorkflowText -match 'matrixrtc-preflight\.ps1\s+-RequireCompose' -and
    $releaseWorkflowText -match 'test-evidence-validation\.ps1' -and
    $releaseWorkflowText -match '-Milestone\s+R3' -and
    $r3SecurityWorkflowText -match 'matrixrtc-preflight\.ps1\s+-RequireCompose' -and
    $r3SecurityWorkflowText -match 'test-evidence-validation\.ps1') `
    "Voice is a beta gate: candidate validation and the R3 security workflow must retain MatrixRTC preflight and evidence-validator tests."
Assert-Condition ($releaseWorkflowText -match 'check:protected-evidence' -and
    $ciWorkflowText -match 'check:protected-evidence') `
    "CI and the beta workflow must test protected evidence provenance before candidate creation."
Assert-Condition ($releaseWorkflowText -match '(?m)^\s+actions:\s+read\s*$' -and
    $releaseWorkflowText -match 'GITHUB_TOKEN:\s*\$\{\{ github\.token \}\}') `
    "Live R0 candidate validation must have read-only Actions access for downloading protected evidence."
Assert-Condition ($ciWorkflowText -match 'protected-ci-results\.mjs' -and
    $securityWorkflowText -match 'protected-security-results\.mjs' -and
    $ciWorkflowText -match '--payload-size' -and
    $securityWorkflowText -match '--payload-size') `
    "Protected CI and security evidence must validate keyed job results and bind the downloadable artifact archive digest and size."
Assert-Condition ($releaseWorkflowText -match 'operator-smoke\.ps1.+-Milestone R2.+r2\.env\.example' -and
    $releaseWorkflowText -match 'operator-smoke\.ps1.+-Milestone R3' -and
    $r3SecurityWorkflowText -match 'operator-smoke\.ps1.+-Milestone R3') `
    "Voice is a beta gate: candidate creation and the R3 security workflow must both retain R3 voice smoke."
Assert-Condition ($operatorSmokeText -match 'ValidateSet\("R2", "R3"\)' -and
    $operatorSmokeText -match '\$voiceAcceptance = \$Milestone -eq "R3"' -and
    $operatorSmokeText -match 'PublicProbeAttempts = 3' -and
    $operatorSmokeText -match 'Invoke-StablePublicJsonRequest' -and
    $operatorSmokeText -match 'MESH_SMOKE_EXPECTED_SERVER_VERSION' -and
    $operatorSmokeText -match 'Get-ReviewedSynapseVersion' -and
    $operatorSmokeText -match 'exact R2 Synapse deployment pin' -and
    $operatorSmokeText -match 'Assert-PublicDnsResolution' -and
    $operatorSmokeText -match 'genuinely external network' -and
    $operatorSmokeText -match 'Read-BoundedResponseBytes' -and
    $operatorSmokeText -match 'HttpCompletionOption\]::ResponseHeadersRead' -and
    $operatorSmokeText -notmatch 'ReadAsByteArrayAsync') `
    "Operator smoke must keep R2 text/community checks independent from later R3 voice infrastructure and stream remote JSON within its declared byte limit."
Assert-Condition ($matrixRtcPreflightText -match '\[switch\]\$RequireLiveAcceptance') `
    "MatrixRTC preflight must retain an explicit complete-live-acceptance evidence gate."
Assert-Condition ($matrixRtcPreflightText -match 'acceptance-matrix\.example\.json') `
    "MatrixRTC preflight must validate the checked physical/network acceptance matrix."
Assert-Condition ($matrixRtcEvidenceModuleText -match 'sourceSha must equal the current') `
    "Complete MatrixRTC evidence must remain bound to the exact current source SHA."
Assert-Condition ($matrixRtcEvidenceModuleText -match '--untracked-files=all') `
    "Complete MatrixRTC evidence must reject tracked and untracked worktree changes."
Assert-Condition ($matrixRtcEvidenceModuleText -match 'Get-FileHash.+SHA256') `
    "Complete MatrixRTC evidence must verify artifact SHA-256 digests."
Assert-Condition ($matrixRtcEvidenceModuleText -match 'resolves outside the explicit evidence root') `
    "Complete MatrixRTC evidence must reject canonical path and symlink escape."
Assert-Condition ($matrixRtcEvidenceTestText -match 'dirty source is rejected' -and
    $matrixRtcEvidenceTestText -match 'changed hash is rejected' -and
    $matrixRtcEvidenceTestText -match 'unknown evidence reference is rejected' -and
    $matrixRtcEvidenceTestText -match 'wrong device is rejected' -and
    $matrixRtcEvidenceTestText -match 'missing TURN relay observation is rejected' -and
    $matrixRtcEvidenceTestText -match 'missing media E2EE observation is rejected' -and
    $matrixRtcEvidenceTestText -match 'generic cross-case evidence is rejected' -and
    $matrixRtcEvidenceTestText -match 'missing network result is rejected') `
    "MatrixRTC evidence tests must retain source, artifact, device, TURN, media-E2EE, and case-binding rejection coverage."
Assert-Condition ($nightlyWorkflowText -match 'browser-resource-budget' -and
    $nightlyWorkflowText -match 'runtime-budgets\.spec\.ts' -and
    $nightlyWorkflowText -match 'resource-budget-browser\.json') `
    "Nightly CI must retain controlled repeated browser resource evidence."
Assert-Condition ($nightlyWorkflowText -match 'for iteration in 1 2' -and
    $nightlyWorkflowText -match 'independentRestoreCycles' -and
    $nightlyWorkflowText -match 'restore-drill-report\.json') `
    "Nightly CI must retain two independently executed restore logs and an exact-SHA evidence report."
Assert-Condition ($resourceProbeText -match 'idle-text-sync' -and
    $resourceProbeText -match 'active-voice' -and
    $resourceProbeText -match 'screen-share' -and
    $resourceProbeText -match 'contextSwitchesPerSecond' -and
    $resourceProbeText -match 'standardDeviation' -and
    $resourceProbeText -match 'sourceSha') `
    "Native resource evidence must retain all scenarios, wakeup-pressure sampling, variance, and exact-SHA provenance."
Assert-Condition ($installedStartupProbeText -match '\[ValidateRange\(10, 100\)\]' -and
    $installedStartupProbeText -match 'UIAutomation' -and
    $installedStartupProbeText -match 'signature\.Status -ne "Valid"' -and
    $installedStartupProbeText -match 'interactiveBudgetMs = 2000' -and
    $installedStartupProbeText -match 'summary\.p95') `
    "Installed startup evidence must use at least ten UI Automation readiness samples, a signed candidate, and the two-second p95 budget."
Assert-Condition ($messageLatencyProbeText -match '\[ValidateRange\(10, 100\)\]' -and
    $messageLatencyProbeText -match 'optimisticP95BudgetMs = 100' -and
    $messageLatencyProbeText -match 'confirmedP95BudgetMs = 1000' -and
    $messageLatencyProbeText -match 'signature\.Status -ne "Valid"' -and
    $messageLatencyProbeText -match ', sending') `
    "Provider latency evidence must use signed-candidate UI Automation samples and distinguish optimistic from confirmed delivery."
Assert-Condition ($packageConfig.scripts.'e2e:large-timeline' -match 'build:performance-fixture' -and
    $packageConfig.scripts.'build:performance-fixture' -match 'performance-fixture' -and
    $packageConfig.scripts.'build:performance-fixture' -match 'dist-performance-fixture' -and
    $largeTimelineSpecText -match 'MESSAGE_COUNT = 10_000' -and
    $largeTimelineSpecText -match 'historyPagesTraversed' -and
    $largeTimelineSpecText -match 'peakRenderedRows' -and
    $largeTimelineSpecText -match 'frameIntervalP95Ms') `
    "The optimized 10,000-message regression fixture must retain pagination, DOM, heap, and frame evidence."
Assert-Condition ($viteConfigText -match '__MESH_PERFORMANCE_FIXTURE__.+mode === "performance-fixture"' -and
    $viteConfigText -match '@mesh/workspace-preview-runtime' -and
    $viteConfigText -match 'command === "serve" \|\| mode === "performance-fixture"' -and
    $viteConfigText -match 'installWorkspacePreview\.disabled\.ts' -and
    $viteConfigText -match '@mesh/workspace-preview-state' -and
    $viteConfigText -match 'WorkspacePreviewState\.disabled\.tsx' -and
    $rendererEntryText -match 'import\.meta\.env\.DEV \|\| __MESH_PERFORMANCE_FIXTURE__' -and
    $rendererEntryText -match "import\('@mesh/workspace-preview-runtime'\)" -and
    $rendererEntryText -match "import\('@mesh/workspace-preview-state'\)" -and
    $disabledPreviewRuntimeText -match 'unavailable in release builds' -and
    $disabledPreviewStateText -match 'return null') `
    "Performance-only preview data must resolve to a disabled runtime in every shipping build mode."
Assert-Condition ($windowsAcceptanceRunbookText -match 'two independent compatible account providers' -and
    $windowsAcceptanceRunbookText -match 'ETW/WPA' -and
    $windowsAcceptanceRunbookText -match 'NVDA' -and
    @($windowsAccessibilityChecklist.cases).Count -eq 5 -and
    @($windowsAccessibilityChecklist.cases | Where-Object { $_.status -ne 'not-run' }).Count -eq 0) `
    "Windows acceptance must retain two-provider performance instructions and an unclaimed five-case physical accessibility template."
Assert-Condition ($releaseWorkflowText -match 'check-matrix-release-dependencies\.ps1') `
    "The beta workflow must mechanically prove the Matrix and legacy dependency boundary."
Assert-Condition ($matrixDependencyBoundaryText -match 'rust-dependency-policy\.json' -and
    $matrixDependencyBoundaryText -match 'cargo audit.+--json' -and
    $matrixDependencyBoundaryText -match 'sourceSha' -and
    $matrixDependencyBoundaryText -match 'cargoLockSha256' -and
    $rustDependencyPolicyText -match 'nonShippingVulnerabilities' -and
    $rustDependencyPolicyText -match 'shippingRuntimeWarnings' -and
    $rustDependencyPolicyText -match 'expectedRawWarningCounts' -and
    $rustDependencyPolicyText -match 'serde_with') `
    "Rust advisory counts, legacy exclusions, and minimum versions must come from one reviewed policy."
Assert-Condition ($releaseWorkflowText -match 'Report raw Rust advisory status' -and
    $releaseWorkflowText -match 'check-matrix-release-dependencies\.ps1' -and
    $releaseWorkflowText -match 'ReportPath release/rust-dependency-report\.json') `
    "The beta workflow must report raw and Matrix release-scoped Rust audit results separately."
Assert-Condition ($releaseWorkflowText -match 'check:bundle-size.+--report' -and
    $releaseWorkflowText -match 'bundle-report\.json' -and
    (Read-Utf8Text (Join-Path $repoRoot "scripts/check-bundle-size.mjs")) -match 'sourceSha') `
    "Release evidence must include a generated bundle-budget report without raising budgets."
Assert-Condition ($releaseWorkflowText -match 'scan-release-artifacts\.ps1') `
    "The beta workflow must scan generated release artifacts for configured secrets."
Assert-Condition ($releaseWorkflowText -match 'check-compiled-installer-coexistence\.ps1' -and
    $developerPreviewWorkflowText -match 'check-compiled-installer-coexistence\.ps1') `
    "Signed candidates and unsigned previews must inspect the compiled MSI coexistence controls after bundling."
Assert-Condition ($releaseArtifactScanText -match 'WINDOWS_CERTIFICATE_PASSWORD' -and
    $releaseArtifactScanText -match 'Test-ByteSequence') `
    "Release artifact scanning must check configured secret values without printing them."
Assert-Condition ($releaseWorkflowText -match 'mesh/SHA256SUMS\.txt' -and
    $releaseWorkflowText -match '(?ms)Attest signed release provenance.*?mesh/SHA256SUMS\.txt') `
    "Release checksums must be part of the attested candidate evidence set."
Assert-Condition ($releaseWorkflowText -notmatch '-Exportable' -and
    $releaseWorkflowText -match 'Remove imported signing certificate' -and
    $releaseWorkflowText -match 'if:\s*always\(\)') `
    "The signing certificate must remain non-exportable and be removed from the ephemeral store even after failure."
Assert-Condition ($developerPreviewWorkflowText -match '(?m)^\s*workflow_dispatch:\s*$') `
    "Unsigned developer previews must be owner-triggered, not published automatically."
Assert-Condition ($developerPreviewWorkflowText -notmatch '(?m)^\s*gh release create\b') `
    "Unsigned developer previews must remain short-lived workflow artifacts, not GitHub releases."
Assert-Condition ($developerPreviewWorkflowText -match 'UNSIGNED-DEVELOPER-PREVIEW') `
    "Developer-preview artifact names must state that the packages are unsigned."
Assert-Condition ($developerPreviewWorkflowText -match '(?m)^\s*retention-days:\s*30\s*$') `
    "Unsigned developer previews must use the bounded 30-day artifact retention."
Assert-Condition ($pagesWorkflowText -match '(?m)^\s*workflow_dispatch:\s*$') `
    "Public pages must require an explicit owner-triggered publication."
Assert-Condition ($pagesWorkflowText -notmatch '(?m)^\s*(?:push|pull_request):\s*$') `
    "Draft legal pages must not deploy automatically from pushes or pull requests."
Assert-Condition ($pagesWorkflowText -match 'confirm_legal_review') `
    "Public page deployment must require an explicit legal-review confirmation."
Assert-Condition ($pagesWorkflowText -match 'actions/deploy-pages@[0-9a-fA-F]{40}') `
    "Public page deployment must use the pinned GitHub Pages action."
Assert-Condition ($securityWorkflowText -match 'github/codeql-action/init@[0-9a-fA-F]{40}' -and
    $securityWorkflowText -match 'github/codeql-action/analyze@[0-9a-fA-F]{40}') `
    "Security CI must retain immutable CodeQL SAST actions."
Assert-Condition ($securityWorkflowText -match '(?ms)Assert Matrix production tree excludes libp2p.*?set -o pipefail.*?cargo tree' -and
    $developerPreviewWorkflowText -match '(?ms)Verify Matrix-only dependency tree.*?set -o pipefail.*?cargo tree') `
    "Matrix dependency-tree exclusion checks must fail if cargo tree itself fails."
Assert-Condition ($securityWorkflowText -match 'actions/dependency-review-action@[0-9a-fA-F]{40}') `
    "Pull requests must retain immutable dependency review."
Assert-Condition ($securityWorkflowText -match 'cargo install cargo-deny --version 0\.20\.2 --locked' -and
    $securityWorkflowText -match 'cargo deny --locked check licenses sources' -and
    $securityWorkflowText -match 'cargo install cargo-geiger --version 0\.13\.0 --locked' -and
    $securityWorkflowText -match '(?ms)cargo geiger.*?--no-default-features.*?--features matrix-voice.*?--locked.*?--output-format Json') `
    "Security CI must enforce the pinned Rust license policy and preserve a Matrix voice unsafe-code inventory."
Assert-Condition ($cargoDenyText -match '(?m)^unknown-registry\s*=\s*"deny"' -and
    $cargoDenyText -match '(?m)^unknown-git\s*=\s*"deny"' -and
    $cargoDenyText -match '"AGPL-3\.0-only"' -and
    $cargoDenyText -match '"MPL-2\.0"') `
    "cargo-deny must fail closed on unknown Rust sources and mirror the reviewed license allowlist."
# A license policy that evaluates one platform's graph says nothing about the
# other two, and it passed for a long time while saying nothing about them.
# Both halves of the coverage are asserted, because narrowing either one back
# would be invisible: the run still succeeds, on less.
foreach ($shippedTriple in @(
    "x86_64-pc-windows-msvc",
    "aarch64-apple-darwin",
    "x86_64-unknown-linux-gnu"
)) {
    Assert-Condition ($cargoDenyText -match [regex]::Escape("`"$shippedTriple`"")) `
        "cargo-deny must evaluate $shippedTriple; D21 promotes all three platforms together, so a policy blind to one is blind for the release."
}
Assert-Condition ($securityWorkflowText -match 'cargo deny --locked --no-default-features --features legacy-p2p check licenses sources') `
    "Security CI must run the license and source policy for the legacy-p2p feature set as well; one deny.toml [graph] block describes one feature selection, so libp2p's graph is otherwise never checked."
Assert-Condition ($dependabotText -match 'package-ecosystem:\s*github-actions' -and
    $dependabotText -match 'package-ecosystem:\s*npm' -and
    $dependabotText -match 'package-ecosystem:\s*cargo') `
    "Dependabot must cover workflows, npm, and Cargo on a schedule."
Assert-Condition ($dependencyReviewConfigText -match 'license-check:\s*true' -and
    $dependencyReviewConfigText -match 'fail-on-severity:\s*moderate') `
    "Dependency review must enforce the reviewed license and vulnerability policy."
Assert-Condition ($codeownersText -match '/\.github/workflows/release-beta\.yml.+@dhawal-ss') `
    "CODEOWNERS must require owner review for release workflow changes."
# State-agnostic. scripts/security-disclosure-drill.mjs owns which confidential
# route state is correct and what each state implies across SECURITY.md, the public
# pages and the incident guide. Pinning one state here made this gate assert a
# superseded truth once the route was enabled. What the preflight owns is that the
# policy declares exactly one recognised state and the drill remains wired up.
$declaresUnavailableRoute = $securityPolicyText -match '(?i)confidential\s+route\s+status:\s+unavailable'
$declaresEnabledRoute = $securityPolicyText -match '(?i)confidential\s+route\s+status:\s+enabled'
Assert-Condition (($declaresUnavailableRoute -xor $declaresEnabledRoute) -and
    (Test-Path -LiteralPath $securityDisclosureDrillPath -PathType Leaf) -and
    $packageConfig.scripts.'check:security-disclosure' -match 'security-disclosure-drill\.mjs' -and
    $licensePolicyText -match 'AGPL-3\.0-only') `
    "SECURITY.md must declare exactly one confidential route state and retain its disclosure drill; public promotion is separately blocked by r2.confidential-security-reporting."

# A gate that runs in no workflow is enforced by whoever remembers to run it.
# These three had tests, had npm scripts, and ran nowhere: the disclosure drill
# that is the only automated check of whether Mesh can receive a vulnerability
# report, the installer coexistence contract, and the boundary keeping the three
# voice lock graphs independent. Asserted here so removing the invocation fails
# the candidate rather than going unnoticed.
# A piped `run:` step reports the exit status of the last command in the pipe.
# GitHub's default shell is `bash -e` without pipefail, so `gate | tee log` goes
# green when the gate fails -- silently disabling the very check the step exists
# to run. Declaring `shell: bash` is what turns pipefail on. Checked per step
# rather than by counting, so a new piped step cannot slip past.
foreach ($pipedWorkflow in @(
    @{ Name = "CI"; Text = $ciWorkflowText },
    @{ Name = "Security"; Text = $securityWorkflowText }
)) {
    $workflowSteps = [regex]::Split($pipedWorkflow.Text, '(?m)^\s*-\s+name:')
    foreach ($workflowStep in $workflowSteps) {
        if ($workflowStep -notmatch '\|\s*tee\b') { continue }
        Assert-Condition ($workflowStep -match '(?m)^\s*shell:\s*bash\s*$') `
            "A $($pipedWorkflow.Name) step pipes into tee without declaring shell: bash, so a failing command in that pipe would report success."
    }
}

foreach ($orphanedGate in @(
    @{ Name = "check:security-disclosure"; Workflow = "Security"; Text = $securityWorkflowText },
    @{ Name = "check:installer-coexistence"; Workflow = "CI"; Text = $ciWorkflowText },
    @{ Name = "check:voice-dependency-boundary"; Workflow = "CI"; Text = $ciWorkflowText }
)) {
    $invocationPattern = "npm run(?:\s+--\S+)*\s+" + [regex]::Escape($orphanedGate.Name)
    Assert-Condition ($orphanedGate.Text -match $invocationPattern) `
        "The $($orphanedGate.Workflow) workflow must run $($orphanedGate.Name); a gate no workflow invokes is not enforced."
}

Assert-Condition ($matrixAcceptanceWorkflowText -match 'npm run setup:matrix-spike:reset') `
    "Matrix federation acceptance must reset the disposable homeservers before every run."
Assert-Condition ($matrixAcceptanceWorkflowText -match 'npm run test:matrix-spike') `
    "Matrix federation acceptance must run the supported live test command."
Assert-Condition ($matrixAcceptanceWorkflowText -match 'for cycle in 1 2' -and
    $matrixAcceptanceWorkflowText -match 'independentResetTestCycles' -and
    $matrixAcceptanceWorkflowText -match 'acceptance-report\.json' -and
    $matrixAcceptanceWorkflowText -match 'matrix-federation-acceptance-\$\{\{ github\.sha \}\}') `
    "Matrix federation acceptance must retain two independent reset/test logs and an exact-SHA evidence report."
Assert-Condition ($matrixAcceptanceWorkflowText -match '(?ms)if:\s*\$\{\{\s*always\(\)\s*\}\}.*?docker compose .*? down') `
    "Matrix federation acceptance must always tear down its disposable homeservers."

$matrixSpikeImages = [regex]::Matches(
    $matrixSpikeComposeText,
    '(?m)^\s*image:\s*(?<image>\S+)\s*$'
)
Assert-Condition ($matrixSpikeImages.Count -gt 0) `
    "Matrix spike Compose configuration has no container images to validate."
foreach ($imageMatch in $matrixSpikeImages) {
    $image = $imageMatch.Groups["image"].Value
    Assert-Condition ($image -match '@sha256:[0-9a-f]{64}$') `
        "Matrix spike image is not pinned to an immutable SHA-256 digest: $image"
}

if (-not [string]::IsNullOrWhiteSpace($Tag)) {
    $expectedTag = "v$tauriVersion"
    Assert-Condition ($Tag -eq $expectedTag) `
        "Release tag $Tag does not match the application version $expectedTag."
    Assert-Condition ($Tag -ne "v0.1.0") `
        "Tag v0.1.0 is a placeholder and cannot publish a Matrix beta."
}

$currentSourceSha = ""
if ($RequireCleanSource -or -not [string]::IsNullOrWhiteSpace($ExpectedSourceSha)) {
    $currentSourceSha = (& git -C $gitRoot rev-parse HEAD).Trim()
    Assert-Condition ($currentSourceSha -match '^[0-9a-f]{40}$') `
        "Could not resolve the exact release source SHA."
}
if (-not [string]::IsNullOrWhiteSpace($ExpectedSourceSha)) {
    Assert-Condition ($ExpectedSourceSha -match '^[0-9a-f]{40}$') `
        "ExpectedSourceSha must be a 40-character Git SHA."
    Assert-Condition ($ExpectedSourceSha -eq $currentSourceSha) `
        "Release source SHA $currentSourceSha does not match ExpectedSourceSha $ExpectedSourceSha."
}
if ($RequireCleanSource) {
    $worktreeState = [string]::Join(
        "`n",
        @(& git -C $gitRoot status --porcelain --untracked-files=all)
    ).Trim()
    Assert-Condition ([string]::IsNullOrWhiteSpace($worktreeState)) `
        "Release source must have a clean tracked and untracked worktree."
    Write-Host "Clean release source verified at $currentSourceSha."
}

if ($RequireProtectedMainAncestry) {
    Assert-Condition (-not [string]::IsNullOrWhiteSpace($Tag)) `
        "Protected-main ancestry validation requires an explicit release tag."
    Assert-Condition ($ProtectedMainRef -match '^refs/remotes/origin/main$') `
        "ProtectedMainRef must be refs/remotes/origin/main."
    & git -C $gitRoot show-ref --verify --quiet $ProtectedMainRef
    Assert-Condition ($LASTEXITCODE -eq 0) `
        "Protected origin/main is unavailable. Fetch it before release validation."
    $tagSourceSha = (& git -C $gitRoot rev-parse "${Tag}^{commit}").Trim()
    $currentSourceSha = (& git -C $gitRoot rev-parse HEAD).Trim()
    Assert-Condition ($tagSourceSha -eq $currentSourceSha) `
        "Release tag $Tag does not resolve to the checked-out source $currentSourceSha."
    & git -C $gitRoot merge-base --is-ancestor $tagSourceSha $ProtectedMainRef
    Assert-Condition ($LASTEXITCODE -eq 0) `
        "Release tag $Tag is not contained in protected origin/main."
    Write-Host "Protected-main release ancestry verified for $Tag at $tagSourceSha."
}

if ($RequireSigningEnvironment) {
    $requiredVariables = @(
        "WINDOWS_CERTIFICATE",
        "WINDOWS_CERTIFICATE_PASSWORD",
        "WINDOWS_CERTIFICATE_THUMBPRINT"
    )
    $missingVariables = $requiredVariables | Where-Object {
        [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_))
    }
    Assert-Condition ($missingVariables.Count -eq 0) `
        "Missing required release secrets: $($missingVariables -join ', ')."

    $oidcRegistrationJson = [Environment]::GetEnvironmentVariable(
        "MESH_OAUTH_CLIENT_REGISTRATIONS_JSON"
    )
    Assert-Condition (-not [string]::IsNullOrWhiteSpace($oidcRegistrationJson)) `
        "MESH_OAUTH_CLIENT_REGISTRATIONS_JSON is required as a reviewed non-secret release build input."
    try {
        $oidcRegistrations = $oidcRegistrationJson | ConvertFrom-Json -Depth 8 -ErrorAction Stop
    } catch {
        throw "MESH_OAUTH_CLIENT_REGISTRATIONS_JSON is not valid JSON."
    }
    Assert-Condition ($oidcRegistrations.version -eq 1) `
        "MESH_OAUTH_CLIENT_REGISTRATIONS_JSON must use schema version 1."
    Assert-Condition (@($oidcRegistrations.registrations).Count -gt 0) `
        "MESH_OAUTH_CLIENT_REGISTRATIONS_JSON must contain at least one reviewed issuer registration."
    foreach ($registration in @($oidcRegistrations.registrations)) {
        Assert-Condition (-not [string]::IsNullOrWhiteSpace([string]$registration.issuer)) `
            "Every OAuth registration must name an exact issuer."
        Assert-Condition (-not [string]::IsNullOrWhiteSpace([string]$registration.clientId)) `
            "Every OAuth registration must include its public desktop client ID."
        Assert-Condition (
            [string]$registration.redirectUri -eq "http://127.0.0.1:8418/oauth/callback"
        ) "Every OAuth registration must use the fixed Mesh loopback callback."
    }

    $normalizedThumbprint = $env:WINDOWS_CERTIFICATE_THUMBPRINT.Replace(" ", "").ToUpperInvariant()
    Assert-Condition ($normalizedThumbprint -match '^[0-9A-F]{40}$') `
        "WINDOWS_CERTIFICATE_THUMBPRINT must be a 40-character hexadecimal certificate thumbprint."

    $certificateBytes = $null
    try {
        try {
            $certificateBytes = [Convert]::FromBase64String($env:WINDOWS_CERTIFICATE)
        } catch {
            throw "WINDOWS_CERTIFICATE is not valid base64."
        }

        $certificates = [Security.Cryptography.X509Certificates.X509Certificate2Collection]::new()
        $storageFlags = `
            [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet -bor `
            [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable
        try {
            $certificates.Import(
                $certificateBytes,
                $env:WINDOWS_CERTIFICATE_PASSWORD,
                $storageFlags
            )
        } catch {
            throw "WINDOWS_CERTIFICATE could not be opened with WINDOWS_CERTIFICATE_PASSWORD."
        }

        $signingCertificate = $certificates |
            Where-Object { $_.Thumbprint -eq $normalizedThumbprint } |
            Select-Object -First 1
        Assert-Condition ($null -ne $signingCertificate) `
            "WINDOWS_CERTIFICATE_THUMBPRINT does not match a certificate in WINDOWS_CERTIFICATE."
        Assert-Condition $signingCertificate.HasPrivateKey `
            "The configured signing certificate does not contain its private key."
        Assert-Condition ($signingCertificate.NotBefore.ToUniversalTime() -le [DateTime]::UtcNow) `
            "The configured signing certificate is not valid yet."
        Assert-Condition ($signingCertificate.NotAfter.ToUniversalTime() -gt [DateTime]::UtcNow) `
            "The configured signing certificate has expired."

        $codeSigningOid = "1.3.6.1.5.5.7.3.3"
        $hasCodeSigningUsage = @(
            $signingCertificate.Extensions |
                Where-Object { $_ -is [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] } |
                ForEach-Object { $_.EnhancedKeyUsages } |
                ForEach-Object { $_.Value }
        ) -contains $codeSigningOid
        Assert-Condition $hasCodeSigningUsage `
            "The configured certificate does not declare the Code Signing enhanced key usage."
    } finally {
        if ($null -ne $certificateBytes) {
            [Array]::Clear($certificateBytes, 0, $certificateBytes.Length)
        }
    }
}

Write-Host "Source preflight passed for Mesh v$tauriVersion."
Write-Host "Updater status: disabled (no plugin, capability, endpoint, key, or updater manifest)."
Write-Host "Release status: Matrix voice signed candidate, draft prerelease only; public promotion remains blocked on live acceptance."

if ($VerifyFrontendBundle) {
    $resolvedFrontendRoot = Resolve-RepoChildPath `
        -Path $FrontendRoot `
        -DefaultPath (Join-Path $repoRoot "dist") `
        -Description "Frontend bundle root"
    Assert-MatrixFrontendBundleBoundary $resolvedFrontendRoot
}

if ($VerifyArtifacts) {
    Assert-Condition ([Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
        [Runtime.InteropServices.OSPlatform]::Windows
    )) "Authenticode artifact verification must run on Windows."

    $expectedSignerThumbprint = [Environment]::GetEnvironmentVariable("WINDOWS_CERTIFICATE_THUMBPRINT")
    Assert-Condition (-not [string]::IsNullOrWhiteSpace($expectedSignerThumbprint)) `
        "WINDOWS_CERTIFICATE_THUMBPRINT is required to verify the expected installer signer."
    $expectedSignerThumbprint = $expectedSignerThumbprint.Replace(" ", "").ToUpperInvariant()
    Assert-Condition ($expectedSignerThumbprint -match '^[0-9A-F]{40}$') `
        "WINDOWS_CERTIFICATE_THUMBPRINT must be a 40-character hexadecimal certificate thumbprint."

    $resolvedBundleRoot = Resolve-RepoChildPath `
        -Path $BundleRoot `
        -DefaultPath (Join-Path $tauriRoot "target/release/bundle") `
        -Description "Bundle root"

    $installers = @(
        Get-ChildItem -LiteralPath $resolvedBundleRoot -Recurse -File |
            Where-Object { $_.Extension -in @(".msi", ".exe") } |
            Sort-Object FullName
    )
    $macArtifacts = @(
        Get-ChildItem -LiteralPath $resolvedBundleRoot -Recurse |
            Where-Object { $_.Name -match '(?i)\.(app|dmg|pkg)$' }
    )
    Assert-Condition ($macArtifacts.Count -eq 0) `
        "macOS artifacts were produced without a notarization gate. Add a dedicated signed/notarized macOS workflow before enabling macOS targets."
    Assert-Condition ($installers.Count -gt 0) "No Windows installers were found under $resolvedBundleRoot."
    Assert-Condition (@($installers | Where-Object Extension -eq ".msi").Count -eq 1) `
        "The release bundle must contain exactly one MSI installer."
    Assert-Condition (@($installers | Where-Object Extension -eq ".exe").Count -eq 1) `
        "The release bundle must contain exactly one NSIS EXE installer."
    foreach ($installer in $installers) {
        Assert-Condition ($installer.Name -match [regex]::Escape($tauriVersion)) `
            "Installer filename does not contain the release version ${tauriVersion}: $($installer.Name)"
    }

    $checksumLines = foreach ($installer in $installers) {
        $signature = Get-AuthenticodeSignature -LiteralPath $installer.FullName
        Assert-Condition ($signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid) `
            "Installer signature is not valid: $($installer.FullName) ($($signature.Status): $($signature.StatusMessage))"
        Assert-Condition ($null -ne $signature.SignerCertificate) `
            "Installer does not expose a signer certificate: $($installer.FullName)"
        $actualSignerThumbprint = $signature.SignerCertificate.Thumbprint.Replace(" ", "").ToUpperInvariant()
        Assert-Condition ($actualSignerThumbprint -eq $expectedSignerThumbprint) `
            "Installer signer does not match WINDOWS_CERTIFICATE_THUMBPRINT: $($installer.FullName)"
        Assert-Condition ($null -ne $signature.TimeStamperCertificate) `
            "Installer is signed but has no trusted timestamp: $($installer.FullName)"

        $hash = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        Write-Host "Verified signed installer: $($installer.Name)"
        "$hash  $($installer.Name)"
    }

    if (-not [string]::IsNullOrWhiteSpace($ChecksumOutput)) {
        if (-not [IO.Path]::IsPathRooted($ChecksumOutput)) {
            $ChecksumOutput = Join-Path $repoRoot $ChecksumOutput
        }
        $checksumLines | Set-Content -LiteralPath $ChecksumOutput -Encoding utf8
        Write-Host "Wrote installer checksums to $ChecksumOutput."
    }
}
