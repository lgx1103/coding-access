# Run the real discovery script with fixture OS queries, without touching apps.
param([Parameter(Mandatory=$true)][string]$ProbePath)
$ErrorActionPreference = 'Stop'
$probe = Get-Content -LiteralPath $ProbePath -Raw
$script:scenario = ''
$script:desktopPath = if ($env:OS -eq 'Windows_NT') { 'C:/desktop/ChatGPT.exe' } else { '/desktop/ChatGPT.exe' }
function Get-Process {
    param($Name, $ErrorAction)
    if ($script:scenario -in @('running', 'running-no-store')) {
        [pscustomobject]@{ Path = $script:desktopPath }
        [pscustomobject]@{ Path = $script:desktopPath }
    }
    # A desktop app's internal CLI runner is not the desktop process.
    [pscustomobject]@{ Path = '/runner/codex.exe' }
}
function Test-Path { param($LiteralPath) return ($LiteralPath -match '[/\\]desktop[/\\]resources[/\\]app.asar$') }
function Get-StartApps {
    param($ErrorAction)
    if ($script:scenario -eq 'fallback') { throw 'StartApps unavailable' }
    if ($script:scenario -in @('running', 'stopped')) {
        [pscustomobject]@{ Name = 'ChatGPT'; AppID = 'OpenAI.Codex_2p2nqsd0c76g0!App' }
    }
    [pscustomobject]@{ Name = 'ChatGPT'; AppID = 'Other.ChatGPT!App' }
}
function Get-AppxPackage {
    param($Name, $ErrorAction)
    if ($script:scenario -eq 'fallback') {
        [pscustomobject]@{ Version = '26.903.8094.0'; PackageFullName = 'fixture'; PackageFamilyName = 'OpenAI.Codex_2p2nqsd0c76g0' }
    }
}
function Get-AppxPackageManifest {
    param($Package, $ErrorAction)
    [pscustomobject]@{ Package = @{ Applications = @{ Application = @(
        @{ Id = 'App'; Executable = 'app\ChatGPT.exe' }
    ) } } }
}
foreach ($case in @('stopped','running','absent','fallback','running-no-store')) {
    $script:scenario = $case
    $raw = & ([scriptblock]::Create($probe))
    $result = $raw | ConvertFrom-Json
    if ($result.running -isnot [bool]) { throw "$case`: running must be boolean" }
    $expectedRunning = $case -in @('running','running-no-store')
    if ($result.running -ne $expectedRunning) { throw "$case`: wrong running state" }
    if ($expectedRunning) {
        if ($result.path -isnot [string] -or $result.path -ne $script:desktopPath) { throw "$case`: wrong executable path" }
    } elseif ($null -ne $result.path) { throw "$case`: path must be JSON null" }
    if ($case -in @('stopped','running','fallback')) {
        if ($result.appId -isnot [string] -or $result.appId -ne 'OpenAI.Codex_2p2nqsd0c76g0!App') { throw "$case`: wrong store identity" }
    } elseif ($null -ne $result.appId) { throw "$case`: appId must be JSON null" }
    Write-Output "$case`: $raw"
}
