[CmdletBinding()]
param(
    [string]$ProjectRoot,

    [string]$StateRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($StateRoot)) {
    $StateRoot = $env:CODEX_WEIXIN_STATE_ROOT
    if ([string]::IsNullOrWhiteSpace($StateRoot)) {
        $localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
        $StateRoot = Join-Path $localAppData "codex-weixin-bridge"
    }
}

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

$resolvedProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$cliPath = Join-Path $resolvedProjectRoot "dist\cli.js"
$bridgeProcesses = @(Get-CimInstance Win32_Process |
    Where-Object {
        $_.CommandLine -and
        $_.CommandLine -like "*$cliPath*"
    } |
    Select-Object ProcessId, CommandLine)

$openClawPorts = @(18789, 8787)
$openClawListeners = @()
foreach ($port in $openClawPorts) {
    $openClawListeners += Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object LocalAddress, LocalPort, OwningProcess
}

$bridgeAccountDirectory = Join-Path $StateRoot "weixin-accounts\accounts"
$openClawStateRoot = if ([string]::IsNullOrWhiteSpace($env:OPENCLAW_STATE_DIR)) {
    Join-Path $env:USERPROFILE ".openclaw"
}
else {
    $env:OPENCLAW_STATE_DIR
}
$openClawAccountIndexPath = Join-Path $openClawStateRoot "openclaw-weixin\accounts.json"
$accountIndexPath = $bridgeAccountDirectory
$accountIndexSource = "bridge"
if (-not (Test-Path -LiteralPath $bridgeAccountDirectory)) {
    $accountIndexPath = $openClawAccountIndexPath
    $accountIndexSource = "openclaw"
}
if (-not (Test-Path -LiteralPath $accountIndexPath)) {
    $accountIndexPath = $bridgeAccountDirectory
    $accountIndexSource = "missing"
}
$accountIds = @()
if (Test-Path -LiteralPath $accountIndexPath) {
    if ($accountIndexSource -eq "bridge") {
        $accountIds = @(Get-ChildItem -LiteralPath $accountIndexPath -Filter "*.json" -File |
            ForEach-Object { $_.BaseName } |
            Sort-Object)
    }
    else {
        $raw = Get-Content -LiteralPath $accountIndexPath -Raw -Encoding UTF8
        $parsed = $raw | ConvertFrom-Json
        $accountIds = @($parsed)
    }
}

$result = [ordered]@{
    ok                 = ($bridgeProcesses.Count -gt 0)
    projectRoot        = $resolvedProjectRoot
    builtCli           = (Test-Path -LiteralPath (Join-Path $ProjectRoot "dist\cli.js"))
    stateRoot          = $StateRoot
    bridgeProcesses    = @($bridgeProcesses)
    openClawListeners  = @($openClawListeners)
    accountIndexPath   = $accountIndexPath
    accountIndexSource = $accountIndexSource
    accountIds         = $accountIds
}

$result | ConvertTo-Json -Depth 8
