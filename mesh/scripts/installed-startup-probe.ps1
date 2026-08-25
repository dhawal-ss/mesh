[CmdletBinding()]
param(
    [string]$CandidatePath,
    [string]$OutputFile,
    [ValidateRange(10, 100)]
    [int]$Runs = 10,
    [ValidateRange(5, 120)]
    [int]$TimeoutSeconds = 30,
    [string[]]$ReadyAutomationName = @(
        "Sign in with Matrix.org",
        "Direct messages",
        "Open an invitation"
    ),
    [switch]$AllowDirtyWorktree,
    [switch]$AllowUnsignedLocal,
    [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptRoot
$interactiveBudgetMs = 2000

function Get-GitText([string[]]$Arguments) {
    $output = & git -C $repoRoot @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Git command failed: git $($Arguments -join ' ')"
    }
    return ([string]::Join("`n", @($output))).Trim()
}

function Get-Summary([double[]]$Values) {
    if ($Values.Count -eq 0) { return $null }
    $sorted = @($Values | Sort-Object)
    $mean = ($Values | Measure-Object -Average).Average
    $middle = [Math]::Floor($sorted.Count / 2)
    $median = if ($sorted.Count % 2 -eq 0) {
        ($sorted[$middle - 1] + $sorted[$middle]) / 2
    } else {
        $sorted[$middle]
    }
    $p95Index = [Math]::Max(0, [Math]::Ceiling($sorted.Count * 0.95) - 1)
    return [ordered]@{
        minimum = [Math]::Round($sorted[0], 3)
        median = [Math]::Round($median, 3)
        p95 = [Math]::Round($sorted[$p95Index], 3)
        maximum = [Math]::Round($sorted[-1], 3)
        mean = [Math]::Round($mean, 3)
        sampleCount = $sorted.Count
    }
}

function Find-ReadyElement(
    [System.Windows.Automation.AutomationElement]$Root,
    [string[]]$Names
) {
    foreach ($name in $Names) {
        $condition = [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::NameProperty,
            $name
        )
        $element = $Root.FindFirst(
            [System.Windows.Automation.TreeScope]::Descendants,
            $condition
        )
        if ($null -ne $element -and $element.Current.IsEnabled) {
            return $element
        }
    }
    return $null
}

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

if ($ValidateOnly) {
    if ($ReadyAutomationName.Count -eq 0) {
        throw "At least one ready UI Automation name is required."
    }
    Write-Host "Installed startup probe validation passed."
    exit 0
}

if (-not $CandidatePath -or -not $OutputFile) {
    throw "CandidatePath and OutputFile are required unless ValidateOnly is used."
}

$resolvedCandidate = [IO.Path]::GetFullPath($CandidatePath)
if (-not (Test-Path -LiteralPath $resolvedCandidate -PathType Leaf) -or
    [IO.Path]::GetExtension($resolvedCandidate) -ne ".exe") {
    throw "CandidatePath must resolve to a Windows executable."
}

$sourceSha = Get-GitText @("rev-parse", "HEAD")
if ($sourceSha -notmatch "^[0-9a-f]{40}$") {
    throw "Could not resolve an exact 40-character source SHA."
}
$worktree = Get-GitText @("status", "--porcelain", "--untracked-files=all")
if ($worktree -and -not $AllowDirtyWorktree) {
    throw "Startup release evidence requires a clean worktree. Use AllowDirtyWorktree only for a local non-release rehearsal."
}

$signature = Get-AuthenticodeSignature -LiteralPath $resolvedCandidate
if ($signature.Status -ne "Valid" -and -not $AllowUnsignedLocal) {
    throw "Startup release evidence requires a candidate with a valid Authenticode signature."
}

$samples = [System.Collections.Generic.List[object]]::new()
for ($run = 1; $run -le $Runs; $run++) {
    $candidateProcess = $null
    try {
        $stopwatch = [Diagnostics.Stopwatch]::StartNew()
        $candidateProcess = Start-Process -FilePath $resolvedCandidate -PassThru
        $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
        $readyElement = $null
        do {
            if ($candidateProcess.HasExited) {
                throw "The candidate exited before an enabled ready control appeared."
            }
            $candidateProcess.Refresh()
            if ($candidateProcess.MainWindowHandle -ne [IntPtr]::Zero) {
                try {
                    $root = [System.Windows.Automation.AutomationElement]::FromHandle(
                        $candidateProcess.MainWindowHandle
                    )
                    $readyElement = Find-ReadyElement $root $ReadyAutomationName
                } catch {
                    $readyElement = $null
                }
            }
            if ($null -eq $readyElement) { Start-Sleep -Milliseconds 25 }
        } while ($null -eq $readyElement -and [DateTimeOffset]::UtcNow -lt $deadline)

        if ($null -eq $readyElement) {
            throw "No enabled ready control appeared within $TimeoutSeconds seconds."
        }
        $stopwatch.Stop()
        $samples.Add([ordered]@{
            run = $run
            interactiveMs = [Math]::Round($stopwatch.Elapsed.TotalMilliseconds, 3)
            readyAutomationName = $readyElement.Current.Name
            readyControlType = $readyElement.Current.ControlType.ProgrammaticName
        })
    } finally {
        if ($null -ne $candidateProcess -and -not $candidateProcess.HasExited) {
            [void]$candidateProcess.CloseMainWindow()
            if (-not $candidateProcess.WaitForExit(3000)) {
                $candidateProcess.Kill($true)
                $candidateProcess.WaitForExit()
            }
        }
    }
}

$summary = Get-Summary ([double[]]@($samples | ForEach-Object { $_.interactiveMs }))
$os = Get-CimInstance Win32_OperatingSystem
$computer = Get-CimInstance Win32_ComputerSystem
$processors = @(Get-CimInstance Win32_Processor)
$resolvedOutput = [IO.Path]::GetFullPath($OutputFile)
$evidence = [ordered]@{
    schemaVersion = 1
    sourceSha = $sourceSha
    dirtyWorktree = [bool]$worktree
    testedAt = [DateTimeOffset]::UtcNow.ToString("o")
    buildType = if ($signature.Status -eq "Valid") { "signed-installed-release" } else { "unsigned-local-rehearsal" }
    candidate = [ordered]@{
        path = $resolvedCandidate
        sha256 = (Get-FileHash -LiteralPath $resolvedCandidate -Algorithm SHA256).Hash.ToLowerInvariant()
        signatureStatus = [string]$signature.Status
        signerSubject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
    }
    platform = [ordered]@{
        os = $os.Caption
        osVersion = $os.Version
        hardware = $computer.Model
        totalPhysicalMemoryBytes = [long]$computer.TotalPhysicalMemory
        processors = @($processors | ForEach-Object { $_.Name })
        logicalProcessorCount = [Environment]::ProcessorCount
    }
    contract = [ordered]@{
        sampleRuns = $Runs
        timeoutSeconds = $TimeoutSeconds
        readyAutomationNames = $ReadyAutomationName
        interactiveBudgetMs = $interactiveBudgetMs
    }
    summary = $summary
    meetsBudget = [bool]($summary.sampleCount -ge 10 -and $summary.p95 -le $interactiveBudgetMs)
    samples = @($samples)
}

$outputParent = Split-Path -Parent $resolvedOutput
if (-not (Test-Path -LiteralPath $outputParent -PathType Container)) {
    New-Item -ItemType Directory -Path $outputParent -Force | Out-Null
}
$evidence | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $resolvedOutput -Encoding UTF8
Write-Host "Installed startup evidence written to $resolvedOutput"
if (-not $evidence.meetsBudget) {
    throw "Installed startup p95 exceeded $interactiveBudgetMs ms."
}
