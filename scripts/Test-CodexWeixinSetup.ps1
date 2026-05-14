[CmdletBinding()]
param(
    [string]$ProjectRoot,

    [string]$CodexWorkspace,

    [string]$StateRoot = "D:\OpenClawWorkspace\tmp\codex-weixin-bridge",

    [string]$OpenClawStateRoot,

    [int]$ConsolePort = 18790,

    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# This setup probe is read-only: it reports paths and health checks, but does not write credentials.
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

if ([string]::IsNullOrWhiteSpace($OpenClawStateRoot)) {
    if (-not [string]::IsNullOrWhiteSpace($env:OPENCLAW_STATE_DIR)) {
        $OpenClawStateRoot = $env:OPENCLAW_STATE_DIR
    }
    else {
        $OpenClawStateRoot = Join-Path $env:USERPROFILE ".openclaw"
    }
}

if ([string]::IsNullOrWhiteSpace($CodexWorkspace)) {
    if (-not [string]::IsNullOrWhiteSpace($env:CODEX_WEIXIN_CWD)) {
        $CodexWorkspace = $env:CODEX_WEIXIN_CWD
    }
    else {
        $CodexWorkspace = $ProjectRoot
    }
}

function Resolve-DisplayPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    try {
        return (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    }
    catch {
        return [System.IO.Path]::GetFullPath($Path)
    }
}

$resolvedProjectRoot = Resolve-DisplayPath -Path $ProjectRoot
$resolvedCodexWorkspace = Resolve-DisplayPath -Path $CodexWorkspace
$resolvedOpenClawStateRoot = Resolve-DisplayPath -Path $OpenClawStateRoot
$checks = @()

function Add-Check {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [bool]$Ok,

        [ValidateSet("ok", "warn", "error")]
        [string]$Severity = "ok",

        [string]$Detail = "",

        [string]$Fix = ""
    )

    if ($Ok) {
        $Severity = "ok"
    }

    $script:checks += [ordered]@{
        name     = $Name
        ok       = $Ok
        severity = $Severity
        detail   = $Detail
        fix      = $Fix
    }
}

function Test-CommandExists {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CommandName
    )

    return $null -ne (Get-Command $CommandName -ErrorAction SilentlyContinue)
}

function Get-ObjectPropertyValue {
    param(
        [AllowNull()]
        [object]$Object,

        [Parameter(Mandatory = $true)]
        [string]$Name,

        [AllowNull()]
        [object]$Default = $null
    )

    if ($null -eq $Object) {
        return $Default
    }

    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $Default
    }

    return $property.Value
}

$packageJsonPath = Join-Path $resolvedProjectRoot "package.json"
$cliPath = Join-Path $resolvedProjectRoot "dist\cli.js"
$inputScriptPath = Join-Path $resolvedProjectRoot "scripts\Send-CodexDesktopInput.ps1"
$modelScriptPath = Join-Path $resolvedProjectRoot "scripts\Set-CodexDesktopModel.ps1"
$accountIndexPath = Join-Path $resolvedOpenClawStateRoot "openclaw-weixin\accounts.json"

Add-Check `
    -Name "Bridge project root" `
    -Ok (Test-Path -LiteralPath $packageJsonPath) `
    -Severity "error" `
    -Detail $resolvedProjectRoot `
    -Fix "Run this script from the bridge repository or pass -ProjectRoot."

Add-Check `
    -Name "CODEX_WEIXIN_CWD workspace" `
    -Ok (Test-Path -LiteralPath $resolvedCodexWorkspace) `
    -Severity "error" `
    -Detail $resolvedCodexWorkspace `
    -Fix "Set CODEX_WEIXIN_CWD to the project directory Codex should edit."

Add-Check `
    -Name "CODEX_WEIXIN_STATE_ROOT absolute path" `
    -Ok ([System.IO.Path]::IsPathRooted($StateRoot)) `
    -Severity "error" `
    -Detail $StateRoot `
    -Fix "Set CODEX_WEIXIN_STATE_ROOT to an absolute local runtime directory, for example D:\OpenClawWorkspace\tmp\codex-weixin-bridge."

Add-Check `
    -Name "Built bridge entry dist\cli.js" `
    -Ok (Test-Path -LiteralPath $cliPath) `
    -Severity "warn" `
    -Detail $cliPath `
    -Fix "Run npm run build before starting the bridge."

Add-Check `
    -Name "Node.js command" `
    -Ok (Test-CommandExists -CommandName "node") `
    -Severity "error" `
    -Detail "node" `
    -Fix "Install Node.js >= 22 and reopen PowerShell."

Add-Check `
    -Name "npm command" `
    -Ok (Test-CommandExists -CommandName "npm") `
    -Severity "error" `
    -Detail "npm" `
    -Fix "Install npm with Node.js and reopen PowerShell."

Add-Check `
    -Name "OPENCLAW_STATE_DIR account index" `
    -Ok (Test-Path -LiteralPath $accountIndexPath) `
    -Severity "error" `
    -Detail $accountIndexPath `
    -Fix "Finish Weixin/OpenClaw login, then set OPENCLAW_STATE_DIR to the root containing openclaw-weixin\accounts.json."

$accountCount = 0
if (Test-Path -LiteralPath $accountIndexPath) {
    try {
        $parsedAccounts = @(Get-Content -LiteralPath $accountIndexPath -Raw -Encoding UTF8 | ConvertFrom-Json)
        $accountCount = $parsedAccounts.Count
        Add-Check `
            -Name "Weixin account count" `
            -Ok ($accountCount -gt 0) `
            -Severity "error" `
            -Detail "$accountCount account(s)" `
            -Fix "Log in at least one Weixin/OpenClaw bot account."
    }
    catch {
        Add-Check `
            -Name "Weixin account index JSON" `
            -Ok $false `
            -Severity "error" `
            -Detail $_.Exception.Message `
            -Fix "Recreate or repair the local openclaw-weixin account index."
    }
}

Add-Check `
    -Name "Desktop input script" `
    -Ok (Test-Path -LiteralPath $inputScriptPath) `
    -Severity "error" `
    -Detail $inputScriptPath `
    -Fix "Keep CODEX_WEIXIN_DESKTOP_INPUT_SCRIPT pointed at scripts\Send-CodexDesktopInput.ps1."

Add-Check `
    -Name "Desktop model script" `
    -Ok (Test-Path -LiteralPath $modelScriptPath) `
    -Severity "error" `
    -Detail $modelScriptPath `
    -Fix "Keep CODEX_WEIXIN_DESKTOP_MODEL_SCRIPT pointed at scripts\Set-CodexDesktopModel.ps1."

$detectedCodexAppId = $env:CODEX_DESKTOP_APP_ID
$startAppsError = $null
if ([string]::IsNullOrWhiteSpace($detectedCodexAppId)) {
    try {
        $codexApps = @(Get-StartApps | Where-Object { $_.Name -like "*Codex*" })
        if ($codexApps.Count -gt 0) {
            $detectedCodexAppId = $codexApps[0].AppID
        }
    }
    catch {
        $startAppsError = $_.Exception.Message
    }
}

Add-Check `
    -Name "CODEX_DESKTOP_APP_ID detection" `
    -Ok (-not [string]::IsNullOrWhiteSpace($detectedCodexAppId)) `
    -Severity "warn" `
    -Detail ($(if ($detectedCodexAppId) { $detectedCodexAppId } else { $startAppsError })) `
    -Fix "Open Codex Desktop once, or set CODEX_DESKTOP_APP_ID from Get-StartApps."

$codexWindows = @(Get-Process -ErrorAction SilentlyContinue |
    Where-Object {
        $_.ProcessName -like "*Codex*" -and
        $_.MainWindowHandle -ne 0
    } |
    Select-Object Id, ProcessName, MainWindowTitle, MainWindowHandle)

Add-Check `
    -Name "Codex Desktop visible window" `
    -Ok ($codexWindows.Count -gt 0) `
    -Severity "warn" `
    -Detail "$($codexWindows.Count) window(s)" `
    -Fix "Start Codex Desktop and finish login before using desktop-ui mode."

$openClawPorts = @(18789, 8787)
$openClawListeners = @()
foreach ($port in $openClawPorts) {
    $openClawListeners += @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object LocalAddress, LocalPort, OwningProcess)
}

Add-Check `
    -Name "OpenClaw/old bridge ports 18789 and 8787" `
    -Ok ($openClawListeners.Count -eq 0) `
    -Severity "warn" `
    -Detail "$($openClawListeners.Count) listener(s)" `
    -Fix "Stop OpenClaw or the old mobile bridge before starting this standalone bridge, unless you intentionally run both."

$bridgeProcesses = @()
try {
    $bridgeProcesses = @(Get-CimInstance Win32_Process |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine -like "*$cliPath*"
        } |
        Select-Object ProcessId, CommandLine)
}
catch {
    Add-Check `
        -Name "Bridge process lookup" `
        -Ok $false `
        -Severity "warn" `
        -Detail $_.Exception.Message `
        -Fix "Run from a normal PowerShell session with WMI/CIM access."
}

$consoleStatus = $null
$consoleSummary = $null
$consoleUrl = "http://127.0.0.1:$ConsolePort/api/status"
try {
    $consoleStatus = Invoke-RestMethod -Uri $consoleUrl -TimeoutSec 2
    $agentStatus = Get-ObjectPropertyValue -Object $consoleStatus -Name "agentStatus"
    $consoleSummary = [ordered]@{
        deliveryMode     = Get-ObjectPropertyValue -Object $consoleStatus -Name "deliveryMode"
        configRiskCount  = Get-ObjectPropertyValue -Object $consoleStatus -Name "configRiskCount"
        agentMode        = Get-ObjectPropertyValue -Object $agentStatus -Name "mode"
        activeCount      = Get-ObjectPropertyValue -Object $consoleStatus -Name "activeCount" -Default (Get-ObjectPropertyValue -Object $agentStatus -Name "activeCount")
        queuedCount      = Get-ObjectPropertyValue -Object $consoleStatus -Name "queuedCount" -Default (Get-ObjectPropertyValue -Object $agentStatus -Name "queuedCount")
        failedTaskCount  = @(Get-ObjectPropertyValue -Object $consoleStatus -Name "failedTasks" -Default @()).Count
        recentRunCount   = @(Get-ObjectPropertyValue -Object $consoleStatus -Name "recentRuns" -Default @()).Count
        transcriptCount  = @(Get-ObjectPropertyValue -Object $consoleStatus -Name "transcripts" -Default @()).Count
    }
    Add-Check `
        -Name "Local console status" `
        -Ok $true `
        -Detail $consoleUrl `
        -Fix ""
}
catch {
    Add-Check `
        -Name "Local console status" `
        -Ok $false `
        -Severity "warn" `
        -Detail $consoleUrl `
        -Fix "Start the bridge, then open or query the local console again."
}

$codexCommandPath = $env:CODEX_CMD_PATH
if ([string]::IsNullOrWhiteSpace($codexCommandPath)) {
    $npmCodexCmd = Join-Path $env:APPDATA "npm\codex.cmd"
    if (Test-Path -LiteralPath $npmCodexCmd) {
        $codexCommandPath = $npmCodexCmd
    }
    elseif (Test-CommandExists -CommandName "codex.cmd") {
        $codexCommandPath = (Get-Command "codex.cmd").Source
    }
}

$suggestedEnv = [ordered]@{
    CODEX_WEIXIN_CWD                  = $resolvedCodexWorkspace
    CODEX_WEIXIN_STATE_ROOT           = $StateRoot
    CODEX_WEIXIN_LOG_ROOT             = $StateRoot
    OPENCLAW_STATE_DIR                = $resolvedOpenClawStateRoot
    CODEX_WEIXIN_DELIVERY_MODE        = "desktop-ui"
    CODEX_WEIXIN_CLI_FALLBACK         = "false"
    CODEX_WEIXIN_CONSOLE_PORT         = "$ConsolePort"
    CODEX_DESKTOP_APP_ID              = $detectedCodexAppId
    CODEX_WEIXIN_DESKTOP_INPUT_SCRIPT = $inputScriptPath
    CODEX_WEIXIN_DESKTOP_MODEL_SCRIPT = $modelScriptPath
    CODEX_CMD_PATH                    = $codexCommandPath
}

$errorCount = @($checks | Where-Object { $_.severity -eq "error" }).Count
$warningCount = @($checks | Where-Object { $_.severity -eq "warn" }).Count

$result = [ordered]@{
    ok                    = ($errorCount -eq 0)
    projectRoot           = $resolvedProjectRoot
    codexWorkspace        = $resolvedCodexWorkspace
    stateRoot             = $StateRoot
    openClawStateRoot     = $resolvedOpenClawStateRoot
    accountIndexPath      = $accountIndexPath
    accountCount          = $accountCount
    bridgeProcessCount    = $bridgeProcesses.Count
    codexWindowCount      = $codexWindows.Count
    openClawListenerCount = $openClawListeners.Count
    consoleUrl            = $consoleUrl
    consoleSummary        = $consoleSummary
    suggestedEnv          = $suggestedEnv
    errorCount            = $errorCount
    warningCount          = $warningCount
    checks                = @($checks)
}

if ($Json) {
    $result | ConvertTo-Json -Depth 8
    exit 0
}

Write-Host "Codex 微信桥本机预检"
Write-Host "状态=$($result.ok) 错误=$errorCount 警告=$warningCount"
Write-Host ""
foreach ($check in $checks) {
    $label = $check.severity.ToUpperInvariant()
    Write-Host "[$label] $($check.name): $($check.detail)"
    if (-not $check.ok -and -not [string]::IsNullOrWhiteSpace($check.fix)) {
        Write-Host "  修复建议: $($check.fix)"
    }
}

Write-Host ""
Write-Host "建议环境变量:"
foreach ($item in $suggestedEnv.GetEnumerator()) {
    if ($null -ne $item.Value -and -not [string]::IsNullOrWhiteSpace([string]$item.Value)) {
        Write-Host ('  {0}="{1}"' -f $item.Key, $item.Value)
    }
}
