[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string[]]$Path
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Test-ByteSequence(
    [byte[]]$Haystack,
    [byte[]]$Needle
) {
    if ($Needle.Length -eq 0 -or $Needle.Length -gt $Haystack.Length) {
        return $false
    }
    for ($offset = 0; $offset -le $Haystack.Length - $Needle.Length; $offset++) {
        $matches = $true
        for ($index = 0; $index -lt $Needle.Length; $index++) {
            if ($Haystack[$offset + $index] -ne $Needle[$index]) {
                $matches = $false
                break
            }
        }
        if ($matches) {
            return $true
        }
    }
    return $false
}

$files = [System.Collections.Generic.List[IO.FileInfo]]::new()
foreach ($candidate in $Path) {
    if (-not (Test-Path -LiteralPath $candidate)) {
        throw "Release artifact scan path does not exist: $candidate"
    }
    $item = Get-Item -LiteralPath $candidate
    if ($item -is [IO.DirectoryInfo]) {
        foreach ($child in Get-ChildItem -LiteralPath $item.FullName -Recurse -File) {
            $files.Add($child)
        }
    } else {
        $files.Add([IO.FileInfo]$item)
    }
}
$files = @($files | Sort-Object FullName -Unique)
if ($files.Count -eq 0) {
    throw "Release artifact scan received no files."
}

$secretEnvironmentNames = @(
    "WINDOWS_CERTIFICATE",
    "WINDOWS_CERTIFICATE_PASSWORD",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    "GITHUB_TOKEN",
    "GH_TOKEN"
)
$secretValues = @(
    $secretEnvironmentNames |
        ForEach-Object { [Environment]::GetEnvironmentVariable($_) } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and $_.Length -ge 8 } |
        Select-Object -Unique
)
$textPatterns = @(
    "(?i)-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    "(?i)(?:access[_-]?token|refresh[_-]?token|api[_-]?secret|turn[_-]?credential)\s*[:=]\s*[`"'][^`"']{8,}",
    "(?i)LIVEKIT_API_SECRET\s*=\s*\S+"
)

foreach ($file in $files) {
    $bytes = [IO.File]::ReadAllBytes($file.FullName)
    foreach ($secretValue in $secretValues) {
        $utf8 = [Text.Encoding]::UTF8.GetBytes($secretValue)
        $utf16 = [Text.Encoding]::Unicode.GetBytes($secretValue)
        if ((Test-ByteSequence $bytes $utf8) -or
            (Test-ByteSequence $bytes $utf16)) {
            throw "Release artifact contains a configured secret value: $($file.Name)"
        }
    }

    if ($file.Extension -in @(".json", ".txt", ".xml", ".yml", ".yaml", ".log")) {
        $text = [Text.Encoding]::UTF8.GetString($bytes)
        foreach ($pattern in $textPatterns) {
            if ($text -match $pattern) {
                throw "Release artifact contains a secret-shaped text pattern: $($file.Name)"
            }
        }
    }
}

Write-Host "Release artifact secret scan passed for $($files.Count) file(s)."
