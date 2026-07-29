[CmdletBinding()]
param(
    [string]$ProjectRoot,

    [string]$StateRoot = "D:\OpenClawWorkspace\tmp\codex-weixin-bridge",

    [switch]$AllowOpenClawRunning,

    [switch]$NoBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

$resolvedProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$openClawListeners = @()
foreach ($port in @(18789, 8787)) {
    $openClawListeners += Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
}

if ($openClawListeners.Count -gt 0 -and -not $AllowOpenClawRunning) {
    throw "OpenClaw or the old bridge appears to be listening on 18789/8787. Stop it first, or rerun with -AllowOpenClawRunning if you intentionally want both processes."
}

if (-not $NoBuild) {
    Push-Location $resolvedProjectRoot
    try {
        npm run build
    }
    finally {
        Pop-Location
    }
}

$logsDir = Join-Path $StateRoot "logs"
New-Item -ItemType Directory -Path $logsDir -Force | Out-Null

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$stdoutPath = Join-Path $logsDir "$timestamp-stdout.log"
$stderrPath = Join-Path $logsDir "$timestamp-stderr.log"
$cliPath = Join-Path $resolvedProjectRoot "dist\cli.js"

if (-not (Test-Path -LiteralPath $cliPath)) {
    throw "Built bridge entry was not found: $cliPath"
}

function Restore-EnvironmentValue {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [AllowNull()]
        [string]$Value
    )

    if ($null -eq $Value) {
        Remove-Item -Path "Env:$Name" -ErrorAction SilentlyContinue
        return
    }

    Set-Item -Path "Env:$Name" -Value $Value
}

$previousStateRoot = $env:CODEX_WEIXIN_STATE_ROOT
$previousLogRoot = $env:CODEX_WEIXIN_LOG_ROOT
try {
    $env:CODEX_WEIXIN_STATE_ROOT = $StateRoot
    $env:CODEX_WEIXIN_LOG_ROOT = $StateRoot

    $process = Start-Process -FilePath "node" `
        -ArgumentList ('"{0}"' -f $cliPath) `
        -WorkingDirectory $resolvedProjectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -PassThru
}
finally {
    Restore-EnvironmentValue -Name "CODEX_WEIXIN_STATE_ROOT" -Value $previousStateRoot
    Restore-EnvironmentValue -Name "CODEX_WEIXIN_LOG_ROOT" -Value $previousLogRoot
}

[ordered]@{
    ok         = $true
    processId  = $process.Id
    projectRoot = $resolvedProjectRoot
    stdoutPath = $stdoutPath
    stderrPath = $stderrPath
    stateRoot  = $StateRoot
} | ConvertTo-Json -Depth 4
