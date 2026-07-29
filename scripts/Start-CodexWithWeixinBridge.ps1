[CmdletBinding()]
param(
    [string]$ProjectRoot,

    [string]$StateRoot = "D:\OpenClawWorkspace\tmp\codex-weixin-bridge",

    [string]$CodexAppId = $env:CODEX_DESKTOP_APP_ID,

    [int]$MonitorIntervalSeconds = 2,

    [int]$CodexStartTimeoutSeconds = 45,

    [switch]$AllowOpenClawRunning,

    [switch]$NoBuild,

    [switch]$NoLaunchCodex
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

$resolvedProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$statusScript = Join-Path $PSScriptRoot "Status-CodexWeixinBridge.ps1"
$startScript = Join-Path $PSScriptRoot "Start-CodexWeixinBridge.ps1"

function Get-ExistingCompanionProcess {
    $scriptPath = $PSCommandPath
    if ([string]::IsNullOrWhiteSpace($scriptPath)) {
        $scriptPath = Join-Path $PSScriptRoot "Start-CodexWithWeixinBridge.ps1"
    }

    @(Get-CimInstance Win32_Process |
        Where-Object {
            ($_.Name -like "powershell*" -or $_.Name -like "pwsh*") -and
            $_.ProcessId -ne $PID -and
            $_.CommandLine -and
            $_.CommandLine -like "*$scriptPath*"
        } |
        Select-Object ProcessId, CommandLine)
}

function Invoke-BridgeStatus {
    $raw = powershell -NoProfile -ExecutionPolicy Bypass -File $statusScript `
        -ProjectRoot $resolvedProjectRoot `
        -StateRoot $StateRoot

    return $raw | ConvertFrom-Json
}

function Start-Bridge {
    $status = Invoke-BridgeStatus
    if ($status.ok) {
        return [ordered]@{
            action = "already-running"
            processIds = @($status.bridgeProcesses | ForEach-Object { $_.ProcessId })
        }
    }

    $args = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $startScript,
        "-ProjectRoot", $resolvedProjectRoot,
        "-StateRoot", $StateRoot
    )
    if ($AllowOpenClawRunning) {
        $args += "-AllowOpenClawRunning"
    }
    if ($NoBuild) {
        $args += "-NoBuild"
    }

    $raw = powershell @args
    return [ordered]@{
        action = "started"
        result = ($raw | ConvertFrom-Json)
    }
}

function Stop-Bridge {
    $status = Invoke-BridgeStatus
    foreach ($bridgeProcess in @($status.bridgeProcesses)) {
        if ($bridgeProcess.ProcessId) {
            Stop-Process -Id $bridgeProcess.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
}

function Get-CodexDesktopWindow {
    @(Get-Process -Name "Codex" -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -and $_.MainWindowHandle -ne 0 } |
        Sort-Object StartTime -Descending |
        Select-Object -First 1)
}

function Wait-CodexDesktopWindow {
    $deadline = (Get-Date).AddSeconds($CodexStartTimeoutSeconds)
    do {
        $window = @(Get-CodexDesktopWindow)
        if ($window.Count -gt 0) {
            return $window[0]
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)

    throw "Codex Desktop window was not found after $CodexStartTimeoutSeconds seconds."
}

function Resolve-CodexDesktopLaunchTarget {
    if (-not [string]::IsNullOrWhiteSpace($CodexAppId)) {
        return [ordered]@{
            kind = "appId"
            value = $CodexAppId
            source = "override"
        }
    }

    $apps = @(Get-StartApps -ErrorAction SilentlyContinue |
        Where-Object {
            ($_.Name -eq "Codex" -or $_.Name -like "*Codex*") -and
            $_.AppID -like "*Codex*"
        } |
        Sort-Object @{ Expression = { if ($_.Name -eq "Codex") { 0 } else { 1 } } }, Name)

    if ($apps.Count -gt 0) {
        return [ordered]@{
            kind = "appId"
            value = $apps[0].AppID
            source = "Get-StartApps"
        }
    }

    throw "Could not find Codex Desktop in Windows Start Apps. Start Codex manually once, or set CODEX_DESKTOP_APP_ID / -CodexAppId to the app id shown by Get-StartApps."
}

function Start-CodexDesktop {
    $existing = @(Get-CodexDesktopWindow)
    if ($existing.Count -gt 0) {
        return $existing[0]
    }

    if ($NoLaunchCodex) {
        throw "Codex Desktop is not open and -NoLaunchCodex was specified."
    }

    $launchTarget = Resolve-CodexDesktopLaunchTarget
    Start-Process -FilePath "explorer.exe" -ArgumentList ("shell:AppsFolder\{0}" -f $launchTarget.value) | Out-Null
    return Wait-CodexDesktopWindow
}

function Test-CodexWindowAlive {
    param([int]$ProcessId)

    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    return ($null -ne $process -and $process.MainWindowHandle -and $process.MainWindowHandle -ne 0)
}

$codexWindow = $null
$bridgeResult = $null

$existingCompanions = @(Get-ExistingCompanionProcess)
if ($existingCompanions.Count -gt 0) {
    [ordered]@{
        ok = $true
        action = "already-bound"
        companionProcesses = @($existingCompanions)
    } | ConvertTo-Json -Depth 6
    return
}

try {
    $bridgeResult = Start-Bridge
    $codexWindow = Start-CodexDesktop

    [ordered]@{
        ok = $true
        action = "bound"
        codexProcessId = $codexWindow.Id
        bridge = $bridgeResult
        monitorIntervalSeconds = $MonitorIntervalSeconds
    } | ConvertTo-Json -Depth 8

    while (Test-CodexWindowAlive -ProcessId $codexWindow.Id) {
        Start-Sleep -Seconds $MonitorIntervalSeconds
    }
}
finally {
    Stop-Bridge
}
