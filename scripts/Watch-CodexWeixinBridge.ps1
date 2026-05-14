[CmdletBinding()]
param(
    [string]$ProjectRoot,

    [string]$StateRoot = "D:\OpenClawWorkspace\tmp\codex-weixin-bridge",

    [int]$IntervalSeconds = 30,

    [switch]$Once,

    [switch]$NoBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

function Get-BridgeStatus {
    $raw = powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "Status-CodexWeixinBridge.ps1") -ProjectRoot $ProjectRoot -StateRoot $StateRoot
    return $raw | ConvertFrom-Json
}

function Start-Bridge {
    $args = @(
        "-ExecutionPolicy", "Bypass",
        "-File", (Join-Path $PSScriptRoot "Start-CodexWeixinBridge.ps1"),
        "-ProjectRoot", $ProjectRoot,
        "-StateRoot", $StateRoot
    )
    if ($NoBuild) {
        $args += "-NoBuild"
    }

    powershell @args
}

do {
    $status = Get-BridgeStatus
    if ($status.ok) {
        [ordered]@{
            ok = $true
            action = "already-running"
            processIds = @($status.bridgeProcesses | ForEach-Object { $_.ProcessId })
            checkedAt = (Get-Date).ToString("o")
        } | ConvertTo-Json -Depth 4
    }
    else {
        $startResult = Start-Bridge
        [ordered]@{
            ok = $true
            action = "started"
            result = $startResult
            checkedAt = (Get-Date).ToString("o")
        } | ConvertTo-Json -Depth 6
    }

    if (-not $Once) {
        Start-Sleep -Seconds $IntervalSeconds
    }
} while (-not $Once)
