[CmdletBinding()]
param(
    [int]$ProcessId,
    [string]$ProviderLabel,
    [string]$RoomLabel,
    [string]$ComposerAutomationName,
    [string]$OutputFile,
    [ValidateRange(10, 100)]
    [int]$Samples = 10,
    [ValidateRange(2, 60)]
    [int]$TimeoutSeconds = 15,
    [switch]$AllowDirtyWorktree,
    [switch]$AllowUnsignedLocal,
    [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptRoot
$optimisticP95BudgetMs = 100
$confirmedP95BudgetMs = 1000

function Get-GitText([string[]]$Arguments) {
    $output = & git -C $repoRoot @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Git command failed: git $($Arguments -join ' ')" }
    return ([string]::Join("`n", @($output))).Trim()
}

function Get-P95([double[]]$Values) {
    $sorted = @($Values | Sort-Object)
    $index = [Math]::Max(0, [Math]::Ceiling($sorted.Count * 0.95) - 1)
    return [Math]::Round($sorted[$index], 3)
}

function Find-ByName(
    [System.Windows.Automation.AutomationElement]$Root,
    [string]$Name
) {
    $condition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        $Name
    )
    return $Root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}

function Get-MessageGroupName(
    [System.Windows.Automation.AutomationElement]$Element
) {
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $current = $Element
    for ($depth = 0; $depth -lt 12 -and $null -ne $current; $depth++) {
        $name = $current.Current.Name
        if ($name -match '^Message from ') { return $name }
        $current = $walker.GetParent($current)
    }
    return $null
}

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

if ($ValidateOnly) {
    Write-Host "Message latency probe validation passed."
    exit 0
}

if ($ProcessId -le 0 -or -not $ProviderLabel -or -not $RoomLabel -or
    -not $ComposerAutomationName -or -not $OutputFile) {
    throw "ProcessId, ProviderLabel, RoomLabel, ComposerAutomationName, and OutputFile are required."
}

$sourceSha = Get-GitText @("rev-parse", "HEAD")
$worktree = Get-GitText @("status", "--porcelain", "--untracked-files=all")
if ($worktree -and -not $AllowDirtyWorktree) {
    throw "Provider latency release evidence requires a clean worktree."
}

$candidateProcess = Get-Process -Id $ProcessId -ErrorAction Stop
$candidateProcess.Refresh()
if ($candidateProcess.MainWindowHandle -eq [IntPtr]::Zero) {
    throw "The target process does not have a visible main window."
}
$candidatePath = $candidateProcess.Path
$signature = Get-AuthenticodeSignature -LiteralPath $candidatePath
if ($signature.Status -ne "Valid" -and -not $AllowUnsignedLocal) {
    throw "Provider latency release evidence requires a candidate with a valid Authenticode signature."
}

$root = [System.Windows.Automation.AutomationElement]::FromHandle(
    $candidateProcess.MainWindowHandle
)
$results = [System.Collections.Generic.List[object]]::new()
for ($sample = 1; $sample -le $Samples; $sample++) {
    $composer = Find-ByName $root $ComposerAutomationName
    if ($null -eq $composer -or -not $composer.Current.IsEnabled) {
        throw "The enabled composer '$ComposerAutomationName' was not found. Keep Mesh focused on the declared room."
    }

    $token = "mesh-latency-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())-$sample"
    $composer.SetFocus()
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    [System.Windows.Forms.SendKeys]::SendWait("{BACKSPACE}")
    [System.Windows.Forms.SendKeys]::SendWait($token)
    Start-Sleep -Milliseconds 25
    $send = Find-ByName $root "Send message"
    if ($null -eq $send -or -not $send.Current.IsEnabled) {
        throw "The send control did not enable after entering the probe token."
    }
    $invoke = $send.GetCurrentPattern(
        [System.Windows.Automation.InvokePattern]::Pattern
    ) -as [System.Windows.Automation.InvokePattern]
    if ($null -eq $invoke) { throw "The send control does not expose UI Automation InvokePattern." }

    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    $invoke.Invoke()
    $optimisticMs = $null
    $confirmedMs = $null
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            $messageText = Find-ByName $root $token
            if ($null -ne $messageText) {
                if ($null -eq $optimisticMs) {
                    $optimisticMs = $stopwatch.Elapsed.TotalMilliseconds
                }
                $groupName = Get-MessageGroupName $messageText
                if ($groupName -and
                    $groupName -notmatch ', sending' -and
                    $groupName -notmatch ', saved for later' -and
                    $groupName -notmatch ', could not send') {
                    $confirmedMs = $stopwatch.Elapsed.TotalMilliseconds
                }
            }
        } catch {
            $messageText = $null
        }
        if ($null -eq $confirmedMs) { Start-Sleep -Milliseconds 10 }
    } while ($null -eq $confirmedMs -and [DateTimeOffset]::UtcNow -lt $deadline)
    $stopwatch.Stop()

    if ($null -eq $optimisticMs -or $null -eq $confirmedMs) {
        throw "Sample $sample did not reach confirmed delivery within $TimeoutSeconds seconds."
    }
    $results.Add([ordered]@{
        sample = $sample
        optimisticMs = [Math]::Round($optimisticMs, 3)
        confirmedMs = [Math]::Round($confirmedMs, 3)
    })
    Start-Sleep -Milliseconds 250
}

$optimistic = [double[]]@($results | ForEach-Object { $_.optimisticMs })
$confirmed = [double[]]@($results | ForEach-Object { $_.confirmedMs })
$optimisticP95 = Get-P95 $optimistic
$confirmedP95 = Get-P95 $confirmed
$resolvedOutput = [IO.Path]::GetFullPath($OutputFile)
$evidence = [ordered]@{
    schemaVersion = 1
    sourceSha = $sourceSha
    dirtyWorktree = [bool]$worktree
    testedAt = [DateTimeOffset]::UtcNow.ToString("o")
    providerLabel = $ProviderLabel
    roomLabel = $RoomLabel
    buildType = if ($signature.Status -eq "Valid") { "signed-installed-release" } else { "unsigned-local-rehearsal" }
    candidate = [ordered]@{
        path = $candidatePath
        sha256 = (Get-FileHash -LiteralPath $candidatePath -Algorithm SHA256).Hash.ToLowerInvariant()
        signatureStatus = [string]$signature.Status
        signerSubject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
    }
    contract = [ordered]@{
        sampleCount = $Samples
        optimisticP95BudgetMs = $optimisticP95BudgetMs
        confirmedP95BudgetMs = $confirmedP95BudgetMs
        timeoutSeconds = $TimeoutSeconds
    }
    summary = [ordered]@{
        optimisticP95Ms = $optimisticP95
        confirmedP95Ms = $confirmedP95
    }
    meetsBudget = [bool](
        $results.Count -ge 10 -and
        $optimisticP95 -le $optimisticP95BudgetMs -and
        $confirmedP95 -le $confirmedP95BudgetMs
    )
    samples = @($results)
}

$outputParent = Split-Path -Parent $resolvedOutput
if (-not (Test-Path -LiteralPath $outputParent -PathType Container)) {
    New-Item -ItemType Directory -Path $outputParent -Force | Out-Null
}
$evidence | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $resolvedOutput -Encoding UTF8
Write-Host "Provider latency evidence written to $resolvedOutput"
if (-not $evidence.meetsBudget) {
    throw "The provider latency p95 exceeded the declared beta budget."
}
