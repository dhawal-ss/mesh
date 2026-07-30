[CmdletBinding()]
param(
    [string]$Tag = "",
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

function Assert-WindowsOnlyBundleTargets {
    param([object]$TauriConfig)

    Assert-Condition ($null -ne $TauriConfig.bundle) `
        "Tauri bundle configuration is missing."
    $targets = @($TauriConfig.bundle.targets | ForEach-Object { [string]$_ })
    $expectedTargets = @("msi", "nsis")
    Assert-Condition ($targets.Count -eq $expectedTargets.Count -and
        (@($targets | Sort-Object) -join ",") -eq (@($expectedTargets | Sort-Object) -join ",")) `
        "The beta release must target exactly the signed Windows MSI and NSIS bundles. Configure a separate notarized macOS workflow before adding macOS targets."
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
    foreach ($legacyChunk in $legacyChunks) {
        Assert-Condition (-not $eagerAssets.Contains($legacyChunk.FullName)) `
            "Legacy SimplePeer chunk is statically reachable from the Matrix entry: $($legacyChunk.FullName)"

        $escapedName = [regex]::Escape($legacyChunk.Name)
        $javascriptChunks = @(
            Get-ChildItem -LiteralPath $Root -Recurse -File -Filter "*.js"
        )
        $staticImporters = @(
            $javascriptChunks |
                Where-Object { $_.FullName -ne $legacyChunk.FullName } |
                Where-Object {
                    $importerRoot = Split-Path -Parent $_.FullName
                    @(
                        Get-StaticJavaScriptImports (Read-Utf8Text $_.FullName) |
                            ForEach-Object {
                                [IO.Path]::GetFullPath((Join-Path $importerRoot $_))
                            } |
                            Where-Object {
                                $_ -eq $legacyChunk.FullName
                            }
                    ).Count -gt 0
                }
        )
        $staticImporterNames = @($staticImporters | ForEach-Object { $_.FullName }) -join ', '
        Assert-Condition ($staticImporters.Count -eq 0) `
            "Legacy SimplePeer code is statically imported by: $staticImporterNames"

        $dynamicImporters = @(
            $javascriptChunks |
                Where-Object {
                    (Read-Utf8Text $_.FullName) -match "import\(\s*[`"']\./$escapedName[`"']\s*\)"
                }
        )
        Assert-Condition ($dynamicImporters.Count -gt 0) `
            "Legacy SimplePeer code must be isolated in an explicitly lazy chunk: $($legacyChunk.FullName)"
    }

    Write-Host "Frontend boundary: Matrix entry and module preloads exclude the SimplePeer implementation."
    if ($legacyChunks.Count -gt 0) {
        Write-Host "Frontend boundary: legacy voice remains isolated in $($legacyChunks.Count) guarded lazy chunk(s)."
    }
}

$packagePath = Join-Path $repoRoot "package.json"
$cargoPath = Join-Path $tauriRoot "Cargo.toml"
$tauriConfigPath = Join-Path $tauriRoot "tauri.conf.json"
$capabilitiesPath = Join-Path $tauriRoot "capabilities/default.json"
$nestedWorkflowRoot = Join-Path $repoRoot ".github/workflows"
$ciWorkflowPath = Join-Path $gitRoot ".github/workflows/ci.yml"
$nightlyWorkflowPath = Join-Path $gitRoot ".github/workflows/nightly-soak.yml"
$releaseWorkflowPath = Join-Path $gitRoot ".github/workflows/release-beta.yml"
$securityWorkflowPath = Join-Path $gitRoot ".github/workflows/security.yml"
$matrixAcceptanceWorkflowPath = Join-Path $gitRoot ".github/workflows/matrix-federation-acceptance.yml"
$developerPreviewWorkflowPath = Join-Path $gitRoot ".github/workflows/developer-preview.yml"
$pagesWorkflowPath = Join-Path $gitRoot ".github/workflows/pages.yml"
$matrixSpikeComposePath = Join-Path $repoRoot "infra/matrix-spike/docker-compose.yml"

$packageConfig = Read-JsonFile $packagePath
$tauriConfig = Read-JsonFile $tauriConfigPath
$cargoText = Read-Utf8Text $cargoPath
$capabilitiesText = Read-Utf8Text $capabilitiesPath
$ciWorkflowText = Read-Utf8Text $ciWorkflowPath
$nightlyWorkflowText = Read-Utf8Text $nightlyWorkflowPath
$releaseWorkflowText = Read-Utf8Text $releaseWorkflowPath
$securityWorkflowText = Read-Utf8Text $securityWorkflowPath
$matrixAcceptanceWorkflowText = Read-Utf8Text $matrixAcceptanceWorkflowPath
$developerPreviewWorkflowText = Read-Utf8Text $developerPreviewWorkflowPath
$pagesWorkflowText = Read-Utf8Text $pagesWorkflowPath
$matrixSpikeComposeText = Read-Utf8Text $matrixSpikeComposePath

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
Assert-Condition ($tauriConfig.identifier -eq "com.mesh.desktop") `
    "The production application identifier must remain com.mesh.desktop."
Assert-WindowsOnlyBundleTargets -TauriConfig $tauriConfig

$defaultFeatures = [regex]::Match(
    $cargoText,
    '(?m)^\s*default\s*=\s*\[\s*"matrix-backend"\s*\]\s*$'
)
Assert-Condition $defaultFeatures.Success `
    "Cargo default features must contain only matrix-backend for the production beta."
Assert-Condition ($releaseWorkflowText -match '(?m)^\s*gh release create .+$') `
    "The beta workflow must create its release only after local artifact verification."
Assert-Condition ($releaseWorkflowText -match '(?m)^\s*--draft\s*`?\s*$') `
    "The beta workflow must create a draft release so evidence can be reviewed before publication."
Assert-Condition ($releaseWorkflowText -match '(?m)^\s*--prerelease\s*`?\s*$') `
    "The beta workflow must mark releases as prereleases."
Assert-Condition ($releaseWorkflowText -match 'npm run tauri -- build --features matrix-backend -- --no-default-features --locked --jobs 1') `
    "The beta workflow must build the locked Matrix-only feature set."

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
Assert-PinnedActions `
    -WorkflowName "matrix-federation-acceptance.yml" `
    -WorkflowText $matrixAcceptanceWorkflowText
Assert-PinnedActions `
    -WorkflowName "developer-preview.yml" `
    -WorkflowText $developerPreviewWorkflowText
Assert-PinnedActions -WorkflowName "pages.yml" -WorkflowText $pagesWorkflowText

Assert-Condition ($releaseWorkflowText -match 'npm run check:public-services') `
    "The beta workflow must validate the reviewed public-service catalog."
Assert-Condition ($releaseWorkflowText -match 'npm run check:public-site') `
    "The beta workflow must validate the public site source."
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

Assert-Condition ($matrixAcceptanceWorkflowText -match 'npm run setup:matrix-spike:reset') `
    "Matrix federation acceptance must reset the disposable homeservers before every run."
Assert-Condition ($matrixAcceptanceWorkflowText -match 'npm run test:matrix-spike') `
    "Matrix federation acceptance must run the supported live test command."
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
Write-Host "Release status: Matrix-only, draft prerelease, signed Windows artifacts required."

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
