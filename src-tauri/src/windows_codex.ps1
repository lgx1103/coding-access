# Shared discovery for installation, running-state checks and launching.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function Test-CodexDesktopPath([string]$Path) {
    if (-not $Path) { return $false }
    $name = [IO.Path]::GetFileName($Path)
    if ($name -notin @('Codex.exe', 'ChatGPT.exe')) { return $false }
    return ((Test-Path -LiteralPath (Join-Path (Split-Path $Path) 'resources\app.asar')) -or ($Path -match '\\WindowsApps\\OpenAI\.Codex[^\\]*\\'))
}
$running = @(Get-Process -Name Codex,ChatGPT -ErrorAction SilentlyContinue | Where-Object { Test-CodexDesktopPath $_.Path })
# Do not serialize an empty pipeline (AutomationNull) or an ETS-wrapped
# Path property. The Rust bridge requires a plain string or JSON null.
$file = $null
if ($running.Count -gt 0) { $file = [string]$running[0].Path }
$appId = $null
# Use package identity, not the localized Start-menu display name. StartApps
# also covers installations whose package manifest cannot be read directly.
try {
    foreach ($app in @(Get-StartApps -ErrorAction Stop)) {
        if ($app.AppID -match '^OpenAI\.Codex[^!]*![^!]+$') {
            $appId = [string]$app.AppID
            break
        }
    }
} catch { }
if (-not $appId) {
    try {
        foreach ($package in @(Get-AppxPackage -Name 'OpenAI.Codex*' -ErrorAction Stop | Sort-Object Version -Descending)) {
            $manifest = Get-AppxPackageManifest -Package $package.PackageFullName -ErrorAction Stop
            foreach ($application in @($manifest.Package.Applications.Application)) {
                if ($application.Id -and $application.Executable -match '(^|\\)(Codex|ChatGPT)\.exe$') {
                    $appId = "$($package.PackageFamilyName)!$($application.Id)"
                    break
                }
            }
            if ($appId) { break }
        }
    } catch { }
}
# Store identity is stable across updates; prefer it to a versioned EXE path.
@{ running = ($running.Count -gt 0); appId = $appId; path = $file } | ConvertTo-Json -Compress
