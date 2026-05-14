[CmdletBinding()]
param(
    [string]$ProjectRoot,

    [string]$StateRoot = "D:\OpenClawWorkspace\tmp\codex-weixin-bridge"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

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

$accountIndexPath = Join-Path $env:USERPROFILE ".openclaw\openclaw-weixin\accounts.json"
$accountIds = @()
if (Test-Path -LiteralPath $accountIndexPath) {
    $raw = Get-Content -LiteralPath $accountIndexPath -Raw -Encoding UTF8
    $parsed = $raw | ConvertFrom-Json
    $accountIds = @($parsed)
}

$result = [ordered]@{
    ok                 = ($bridgeProcesses.Count -gt 0)
    projectRoot        = $resolvedProjectRoot
    builtCli           = (Test-Path -LiteralPath (Join-Path $ProjectRoot "dist\cli.js"))
    stateRoot          = $StateRoot
    bridgeProcesses    = @($bridgeProcesses)
    openClawListeners  = @($openClawListeners)
    accountIndexPath   = $accountIndexPath
    accountIds         = $accountIds
}

$result | ConvertTo-Json -Depth 8
