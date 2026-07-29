[CmdletBinding()]
param(
    [string]$ShortcutPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ShortcutPath)) {
    $ShortcutPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "Codex + Weixin Bridge.lnk"
}

$launcherPath = Join-Path $PSScriptRoot "Launch-CodexWithWeixinBridge-Hidden.vbs"
if (-not (Test-Path -LiteralPath $launcherPath)) {
    throw "Hidden launcher was not found: $launcherPath"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
$shortcut.TargetPath = Join-Path $env:WINDIR "System32\wscript.exe"
$shortcut.Arguments = ('"{0}"' -f $launcherPath)
$shortcut.WorkingDirectory = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$shortcut.Description = "Start Codex Desktop together with the Weixin bridge. The launcher discovers Codex from Windows Start Apps on each computer."
$shortcut.Save()

[ordered]@{
    ok = $true
    shortcutPath = $ShortcutPath
    launcherPath = $launcherPath
} | ConvertTo-Json -Depth 4
