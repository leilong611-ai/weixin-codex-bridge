[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ModelName,

    [double]$ClickXRatio = -1,

    [double]$ClickYRatio = -1
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class CodexDesktopModelWindow {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr SetActiveWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr SetFocus(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out MODEL_RECT rect);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}

public struct MODEL_RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
}
"@

function ShowWindowWithoutResizing([IntPtr]$Handle) {
    if ([CodexDesktopModelWindow]::IsIconic($Handle)) {
        [void][CodexDesktopModelWindow]::ShowWindowAsync($Handle, 9)
        Start-Sleep -Milliseconds 250
        return
    }

    [void][CodexDesktopModelWindow]::ShowWindowAsync($Handle, 5)
    Start-Sleep -Milliseconds 120
}

function Focus-CodexDesktopWindow([System.Diagnostics.Process]$Process) {
    $foregroundProcessId = [uint32]0
    $foregroundHandle = [CodexDesktopModelWindow]::GetForegroundWindow()
    $foregroundThread = [CodexDesktopModelWindow]::GetWindowThreadProcessId($foregroundHandle, [ref]$foregroundProcessId)
    $targetProcessId = [uint32]0
    $targetThread = [CodexDesktopModelWindow]::GetWindowThreadProcessId($Process.MainWindowHandle, [ref]$targetProcessId)
    $currentThread = [CodexDesktopModelWindow]::GetCurrentThreadId()
    $attachedForeground = $false
    $attachedTarget = $false

    try {
        if ($foregroundThread -ne 0 -and $foregroundThread -ne $currentThread) {
            $attachedForeground = [CodexDesktopModelWindow]::AttachThreadInput($currentThread, $foregroundThread, $true)
        }
        if ($targetThread -ne 0 -and $targetThread -ne $currentThread -and $targetThread -ne $foregroundThread) {
            $attachedTarget = [CodexDesktopModelWindow]::AttachThreadInput($currentThread, $targetThread, $true)
        }

        ShowWindowWithoutResizing $Process.MainWindowHandle
        [void][CodexDesktopModelWindow]::BringWindowToTop($Process.MainWindowHandle)
        [void][CodexDesktopModelWindow]::SetActiveWindow($Process.MainWindowHandle)
        [void][CodexDesktopModelWindow]::SetFocus($Process.MainWindowHandle)
        [void][CodexDesktopModelWindow]::SetForegroundWindow($Process.MainWindowHandle)
        [CodexDesktopModelWindow]::SwitchToThisWindow($Process.MainWindowHandle, $true)
    }
    finally {
        if ($attachedTarget) {
            [void][CodexDesktopModelWindow]::AttachThreadInput($currentThread, $targetThread, $false)
        }
        if ($attachedForeground) {
            [void][CodexDesktopModelWindow]::AttachThreadInput($currentThread, $foregroundThread, $false)
        }
    }

    Start-Sleep -Milliseconds 350
    try {
        $shell = New-Object -ComObject WScript.Shell
        [void]$shell.AppActivate($Process.Id)
        Start-Sleep -Milliseconds 250
    }
    catch {
        # The Win32 handle path above is the primary focus path.
    }

    [uint32]$foregroundPid = 0
    $foregroundHandle = [CodexDesktopModelWindow]::GetForegroundWindow()
    [void][CodexDesktopModelWindow]::GetWindowThreadProcessId($foregroundHandle, [ref]$foregroundPid)
    if ($foregroundPid -ne [uint32]$Process.Id) {
        throw "Codex Desktop window did not become the foreground window. Foreground pid: $foregroundPid; target pid: $($Process.Id)."
    }
}

function Get-EnvDouble([string]$Name, [double]$DefaultValue) {
    $raw = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return $DefaultValue
    }

    $value = 0.0
    if ([double]::TryParse($raw, [ref]$value)) {
        return $value
    }

    return $DefaultValue
}

function Click-At([int]$X, [int]$Y) {
    [void][CodexDesktopModelWindow]::SetCursorPos($X, $Y)
    Start-Sleep -Milliseconds 120
    [CodexDesktopModelWindow]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    [CodexDesktopModelWindow]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}

function Click-WindowRatio([MODEL_RECT]$Rect, [double]$XRatio, [double]$YRatio) {
    $width = $Rect.Right - $Rect.Left
    $height = $Rect.Bottom - $Rect.Top
    $x = [int]($Rect.Left + ($width * $XRatio))
    $y = [int]($Rect.Top + ($height * $YRatio))
    Click-At $x $y
}

function Get-ModelMenuSelection([string]$ModelName) {
    switch ($ModelName.ToLowerInvariant()) {
        "gpt-5.5" {
            return @{
                UseOtherMenu = $false
                TargetXRatio = 0.82
                TargetYRatio = 0.902
            }
        }
        "gpt-5.4" {
            return @{
                UseOtherMenu = $false
                TargetXRatio = 0.82
                TargetYRatio = 0.93
            }
        }
        "gpt-5.4-mini" {
            return @{
                UseOtherMenu = $true
                TargetXRatio = 0.735
                TargetYRatio = 0.895
            }
        }
        "gpt-5.3-codex" {
            return @{
                UseOtherMenu = $true
                TargetXRatio = 0.735
                TargetYRatio = 0.921
            }
        }
        "gpt-5.3-codex-spark" {
            return @{
                UseOtherMenu = $true
                TargetXRatio = 0.735
                TargetYRatio = 0.947
            }
        }
        "gpt-5.2" {
            return @{
                UseOtherMenu = $true
                TargetXRatio = 0.735
                TargetYRatio = 0.975
            }
        }
        default {
            throw "Unsupported Codex Desktop model menu target: $ModelName"
        }
    }
}

function Select-CodexDesktopModelFromMenu([MODEL_RECT]$Rect, [string]$ModelName, [double]$ModelButtonXRatio, [double]$ModelButtonYRatio) {
    $selection = Get-ModelMenuSelection $ModelName

    Click-WindowRatio $Rect $ModelButtonXRatio $ModelButtonYRatio
    Start-Sleep -Milliseconds 350

    Click-WindowRatio $Rect 0.735 0.87
    Start-Sleep -Milliseconds 300

    if ($selection.UseOtherMenu) {
        Click-WindowRatio $Rect 0.82 0.955
        Start-Sleep -Milliseconds 300
    }

    Click-WindowRatio $Rect $selection.TargetXRatio $selection.TargetYRatio
    Start-Sleep -Milliseconds 700
    return $true
}

function Get-ModelVerificationLabels([string]$ModelName) {
    switch ($ModelName.ToLowerInvariant()) {
        "gpt-5.5" { return @("gpt-5.5", "5.5") }
        "gpt-5.4" { return @("gpt-5.4", "5.4") }
        "gpt-5.4-mini" { return @("gpt-5.4-mini", "5.4-mini") }
        "gpt-5.3-codex" { return @("gpt-5.3-codex", "5.3-codex") }
        "gpt-5.3-codex-spark" { return @("gpt-5.3-codex-spark", "5.3-codex-spark") }
        "gpt-5.2" { return @("gpt-5.2", "5.2") }
        default { return @($ModelName) }
    }
}

function Test-CodexWindowContainsText([IntPtr]$Handle, [string]$Text) {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($Handle)
    if (-not $root) {
        return $false
    }

    $needle = $Text.ToLowerInvariant()
    $elements = $root.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
    )

    foreach ($element in $elements) {
        $name = ""
        try {
            $name = [string]$element.Current.Name
        }
        catch {
            $name = ""
        }
        if ($name -and $name.ToLowerInvariant().Contains($needle)) {
            return $true
        }

        try {
            $valuePattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            $value = [string]$valuePattern.Current.Value
            if ($value -and $value.ToLowerInvariant().Contains($needle)) {
                return $true
            }
        }
        catch {
            # Not every UIA element supports ValuePattern.
        }
    }

    return $false
}

function Test-CodexWindowContainsModel([IntPtr]$Handle, [string]$ModelName) {
    foreach ($label in (Get-ModelVerificationLabels $ModelName)) {
        if (Test-CodexWindowContainsText $Handle $label) {
            return $true
        }
    }

    return $false
}

$codexProcess = Get-Process -Name "Codex" -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Sort-Object StartTime -Descending |
    Select-Object -First 1

if (-not $codexProcess) {
    throw "Codex Desktop window was not found."
}

Focus-CodexDesktopWindow $codexProcess

[System.Windows.Forms.SendKeys]::SendWait("{ESC}")
Start-Sleep -Milliseconds 180

$rect = New-Object MODEL_RECT
if (-not [CodexDesktopModelWindow]::GetWindowRect($codexProcess.MainWindowHandle, [ref]$rect)) {
    throw "Could not read Codex Desktop window bounds."
}

if ($ClickXRatio -lt 0) {
    $ClickXRatio = Get-EnvDouble "CODEX_DESKTOP_MODEL_CLICK_X_RATIO" 0.69
}
if ($ClickYRatio -lt 0) {
    $ClickYRatio = Get-EnvDouble "CODEX_DESKTOP_MODEL_CLICK_Y_RATIO" 0.935
}

$selectedByMenu = Select-CodexDesktopModelFromMenu $rect $ModelName $ClickXRatio $ClickYRatio

if (Test-CodexWindowContainsModel $codexProcess.MainWindowHandle $ModelName) {
    Write-Output "Verified Codex Desktop model: $ModelName"
}
elseif ($selectedByMenu) {
    Write-Output "Selected Codex Desktop model by menu: $ModelName"
}
else {
    Write-Output "Clicked Codex Desktop model switch to $ModelName using click ratio $ClickXRatio,$ClickYRatio, but could not verify the visible model."
}
