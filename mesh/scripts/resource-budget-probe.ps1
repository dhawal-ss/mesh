[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet("idle-text-sync", "active-voice", "screen-share")]
    [string]$Scenario,

    [Parameter(Mandatory)]
    [int]$ProcessId,

    [Parameter(Mandatory)]
    [string]$OutputFile,

    [ValidateRange(5, 3600)]
    [int]$SampleSeconds = 60,

    [ValidateRange(1, 60)]
    [int]$IntervalSeconds = 1,

    [ValidateRange(0, 600)]
    [int]$SettlingSeconds = 30,

    [ValidateSet("debug", "release", "installed-release")]
    [string]$BuildType = "release",

    [switch]$AllowDirtyWorktree
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptRoot

function Get-GitText([string[]]$Arguments) {
    $output = & git -C $repoRoot @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Git command failed: git $($Arguments -join ' ')"
    }
    return ([string]::Join("`n", @($output))).Trim()
}

function Get-ProcessTreeIds([int]$RootId) {
    $processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
    $ids = [System.Collections.Generic.HashSet[int]]::new()
    [void]$ids.Add($RootId)
    do {
        $added = $false
        foreach ($process in $processes) {
            if ($ids.Contains([int]$process.ParentProcessId) -and
                $ids.Add([int]$process.ProcessId)) {
                $added = $true
            }
        }
    } while ($added)
    return @($ids)
}

function Get-Summary([double[]]$Values) {
    if ($Values.Count -eq 0) {
        return $null
    }
    $mean = ($Values | Measure-Object -Average).Average
    $variance = (
        $Values |
            ForEach-Object { [Math]::Pow($_ - $mean, 2) } |
            Measure-Object -Average
    ).Average
    return [ordered]@{
        minimum = ($Values | Measure-Object -Minimum).Minimum
        maximum = ($Values | Measure-Object -Maximum).Maximum
        mean = [Math]::Round($mean, 3)
        standardDeviation = [Math]::Round([Math]::Sqrt($variance), 3)
        sampleCount = $Values.Count
    }
}

$sourceSha = Get-GitText @("rev-parse", "HEAD")
if ($sourceSha -notmatch "^[0-9a-f]{40}$") {
    throw "Could not resolve an exact 40-character source SHA."
}
$worktree = Get-GitText @("status", "--porcelain", "--untracked-files=all")
if ($worktree -and -not $AllowDirtyWorktree) {
    throw "Resource evidence requires a clean tracked and untracked worktree. Use -AllowDirtyWorktree only for non-release probe validation."
}

$rootProcess = Get-Process -Id $ProcessId -ErrorAction Stop
if ($rootProcess.HasExited) {
    throw "The target process has already exited."
}

if ($SettlingSeconds -gt 0) {
    Write-Host "Settling $Scenario for $SettlingSeconds second(s) before sampling."
    Start-Sleep -Seconds $SettlingSeconds
}

$logicalProcessorCount = [Environment]::ProcessorCount
$samples = [System.Collections.Generic.List[object]]::new()
$previousCpuSeconds = @{}
$previousCapturedAt = $null
$sampleCount = [Math]::Ceiling($SampleSeconds / $IntervalSeconds)

for ($index = 0; $index -lt $sampleCount; $index++) {
    $capturedAt = [DateTimeOffset]::UtcNow
    $treeIds = @(Get-ProcessTreeIds $ProcessId)
    $processes = @(
        $treeIds |
            ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue } |
            Where-Object { $null -ne $_ -and -not $_.HasExited }
    )
    if ($processes.Count -eq 0) {
        throw "The target process tree exited during sampling."
    }

    $workingSetBytes = [long](($processes | Measure-Object WorkingSet64 -Sum).Sum)
    $privateBytes = [long](($processes | Measure-Object PrivateMemorySize64 -Sum).Sum)
    $cpuSeconds = [double](($processes | Measure-Object CPU -Sum).Sum)
    $cpuPercent = $null
    if ($null -ne $previousCapturedAt) {
        $elapsedSeconds = ($capturedAt - $previousCapturedAt).TotalSeconds
        $previousTotal = if ($previousCpuSeconds.ContainsKey("total")) {
            [double]$previousCpuSeconds["total"]
        } else {
            $cpuSeconds
        }
        if ($elapsedSeconds -gt 0) {
            $cpuPercent = [Math]::Round(
                (($cpuSeconds - $previousTotal) / $elapsedSeconds) *
                    (100 / $logicalProcessorCount),
                3
            )
        }
    }

    $contextSwitchesPerSecond = $null
    try {
        $threadCounters = @(
            Get-CimInstance Win32_PerfFormattedData_PerfProc_Thread |
                Where-Object { $treeIds -contains [int]$_.IDProcess }
        )
        if ($threadCounters.Count -gt 0) {
            $contextSwitchesPerSecond = [double](
                ($threadCounters | Measure-Object ContextSwitchesPersec -Sum).Sum
            )
        }
    } catch {
        # Context switches are a documented wakeup-pressure proxy. Some Windows
        # images disable the formatted performance provider; leave the value
        # null rather than inventing a wakeup number.
    }

    $samples.Add([ordered]@{
        capturedAt = $capturedAt.ToString("o")
        processCount = $processes.Count
        workingSetBytes = $workingSetBytes
        privateBytes = $privateBytes
        cpuPercent = $cpuPercent
        contextSwitchesPerSecond = $contextSwitchesPerSecond
    })
    $previousCpuSeconds["total"] = $cpuSeconds
    $previousCapturedAt = $capturedAt

    if ($index -lt $sampleCount - 1) {
        Start-Sleep -Seconds $IntervalSeconds
    }
}

$os = Get-CimInstance Win32_OperatingSystem
$computer = Get-CimInstance Win32_ComputerSystem
$processors = @(Get-CimInstance Win32_Processor)
$cpuValues = @($samples | ForEach-Object { $_.cpuPercent } | Where-Object { $null -ne $_ })
$contextSwitchValues = @(
    $samples |
        ForEach-Object { $_.contextSwitchesPerSecond } |
        Where-Object { $null -ne $_ }
)
$evidence = [ordered]@{
    schemaVersion = 1
    sourceSha = $sourceSha
    dirtyWorktree = [bool]$worktree
    testedAt = [DateTimeOffset]::UtcNow.ToString("o")
    scenario = $Scenario
    buildType = $BuildType
    sampleDurationSeconds = $SampleSeconds
    sampleIntervalSeconds = $IntervalSeconds
    settlingSeconds = $SettlingSeconds
    rootProcess = [ordered]@{
        id = $ProcessId
        name = $rootProcess.ProcessName
        path = $rootProcess.Path
    }
    platform = [ordered]@{
        os = $os.Caption
        osVersion = $os.Version
        hardware = $computer.Model
        totalPhysicalMemoryBytes = [long]$computer.TotalPhysicalMemory
        processors = @($processors | ForEach-Object { $_.Name })
        logicalProcessorCount = $logicalProcessorCount
    }
    measurement = [ordered]@{
        cpuWakeupsAvailable = $false
        wakeupProxy = "Windows formatted per-thread context switches per second"
        wakeupLimitation = "Release evidence still requires an owner-run ETW/WPA wakeup capture on the target hardware."
    }
    summary = [ordered]@{
        workingSetBytes = Get-Summary @($samples | ForEach-Object { [double]$_.workingSetBytes })
        privateBytes = Get-Summary @($samples | ForEach-Object { [double]$_.privateBytes })
        cpuPercent = Get-Summary ([double[]]$cpuValues)
        contextSwitchesPerSecond = Get-Summary ([double[]]$contextSwitchValues)
    }
    samples = @($samples)
}

$resolvedOutput = [IO.Path]::GetFullPath($OutputFile)
$outputParent = Split-Path -Parent $resolvedOutput
if (-not (Test-Path -LiteralPath $outputParent -PathType Container)) {
    New-Item -ItemType Directory -Path $outputParent -Force | Out-Null
}
$evidence | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $resolvedOutput -Encoding UTF8
Write-Host "Resource evidence written to $resolvedOutput"
