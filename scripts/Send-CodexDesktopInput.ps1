[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PromptPath,

    [switch]$DetectOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:UiAutomationAvailable = $false
try {
    Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
    $script:UiAutomationAvailable = $true
}
catch {
    $script:UiAutomationAvailable = $false
}

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class CodexDesktopWindow {
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
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);
}

public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
}
"@

function Enable-DpiAwareCoordinates {
    try {
        # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4.
        [void][CodexDesktopWindow]::SetProcessDpiAwarenessContext([IntPtr](-4))
        return
    }
    catch {
        try {
            [void][CodexDesktopWindow]::SetProcessDPIAware()
        }
        catch {
            Write-Verbose "Could not enable DPI-aware coordinates: $($_.Exception.Message)"
        }
    }
}

function ShowWindowWithoutResizing([IntPtr]$Handle) {
    if ([CodexDesktopWindow]::IsIconic($Handle)) {
        [void][CodexDesktopWindow]::ShowWindowAsync($Handle, 9)
        Start-Sleep -Milliseconds 250
        return
    }

    [void][CodexDesktopWindow]::ShowWindowAsync($Handle, 5)
    Start-Sleep -Milliseconds 120
}

function Focus-CodexDesktopWindow([System.Diagnostics.Process]$Process) {
    $foregroundProcessId = [uint32]0
    $foregroundHandle = [CodexDesktopWindow]::GetForegroundWindow()
    $foregroundThread = [CodexDesktopWindow]::GetWindowThreadProcessId($foregroundHandle, [ref]$foregroundProcessId)
    $targetProcessId = [uint32]0
    $targetThread = [CodexDesktopWindow]::GetWindowThreadProcessId($Process.MainWindowHandle, [ref]$targetProcessId)
    $currentThread = [CodexDesktopWindow]::GetCurrentThreadId()
    $attachedForeground = $false
    $attachedTarget = $false

    try {
        if ($foregroundThread -ne 0 -and $foregroundThread -ne $currentThread) {
            $attachedForeground = [CodexDesktopWindow]::AttachThreadInput($currentThread, $foregroundThread, $true)
        }
        if ($targetThread -ne 0 -and $targetThread -ne $currentThread -and $targetThread -ne $foregroundThread) {
            $attachedTarget = [CodexDesktopWindow]::AttachThreadInput($currentThread, $targetThread, $true)
        }

        ShowWindowWithoutResizing $Process.MainWindowHandle
        [void][CodexDesktopWindow]::BringWindowToTop($Process.MainWindowHandle)
        [void][CodexDesktopWindow]::SetActiveWindow($Process.MainWindowHandle)
        [void][CodexDesktopWindow]::SetFocus($Process.MainWindowHandle)
        [void][CodexDesktopWindow]::SetForegroundWindow($Process.MainWindowHandle)
        [CodexDesktopWindow]::SwitchToThisWindow($Process.MainWindowHandle, $true)
    }
    finally {
        if ($attachedTarget) {
            [void][CodexDesktopWindow]::AttachThreadInput($currentThread, $targetThread, $false)
        }
        if ($attachedForeground) {
            [void][CodexDesktopWindow]::AttachThreadInput($currentThread, $foregroundThread, $false)
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

    Verify-ForegroundProcess $Process "after focusing Codex Desktop"
}

function Verify-ForegroundProcess([System.Diagnostics.Process]$Process, [string]$Step) {
    [uint32]$foregroundPid = 0
    $foregroundHandle = [CodexDesktopWindow]::GetForegroundWindow()
    [void][CodexDesktopWindow]::GetWindowThreadProcessId($foregroundHandle, [ref]$foregroundPid)
    if ($foregroundPid -ne [uint32]$Process.Id) {
        throw "Codex Desktop window did not remain foreground $Step. Foreground pid: $foregroundPid; target pid: $($Process.Id)."
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

function Get-ObjectPropertyValue([object]$Object, [string]$Name, [object]$DefaultValue) {
    if ($null -eq $Object) {
        return $DefaultValue
    }

    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) {
        return $DefaultValue
    }

    return $property.Value
}

function Get-DesktopInputDebugDir {
    $debugDir = [Environment]::GetEnvironmentVariable("CODEX_DESKTOP_INPUT_DEBUG_DIR")
    if ([string]::IsNullOrWhiteSpace($debugDir)) {
        return "D:\OpenClawWorkspace\tmp\codex-weixin-bridge\debug"
    }

    return $debugDir
}

function Get-DesktopInputCalibrationPath {
    $calibrationPath = [Environment]::GetEnvironmentVariable("CODEX_DESKTOP_INPUT_CALIBRATION_PATH")
    if ([string]::IsNullOrWhiteSpace($calibrationPath)) {
        return (Join-Path (Get-DesktopInputDebugDir) "codex-desktop-input-calibration.json")
    }

    return $calibrationPath
}

function Save-WindowScreenshot([RECT]$Rect, [string]$Path) {
    $width = $Rect.Right - $Rect.Left
    $height = $Rect.Bottom - $Rect.Top
    if ($width -le 0 -or $height -le 0) {
        throw "Window rectangle is invalid: left=$($Rect.Left); top=$($Rect.Top); right=$($Rect.Right); bottom=$($Rect.Bottom)."
    }

    $parent = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }

    $bitmap = New-Object System.Drawing.Bitmap $width, $height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($Rect.Left, $Rect.Top, 0, 0, (New-Object System.Drawing.Size $width, $height))
        $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

function Capture-DesktopInputDiagnostics([RECT]$Rect, [object]$ComposerPoint, [int]$ClickX, [int]$ClickY, [string]$Mode) {
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
    $screenshotPath = Join-Path (Get-DesktopInputDebugDir) "codex-desktop-input-$timestamp.png"
    $borderRole = Get-ObjectPropertyValue $ComposerPoint "BorderRole" "none"
    $borderY = Get-ObjectPropertyValue $ComposerPoint "BorderY" "none"
    $borderWidth = Get-ObjectPropertyValue $ComposerPoint "Width" "none"

    try {
        Save-WindowScreenshot $Rect $screenshotPath
        Write-Output "Desktop input diagnostics: screenshot=$screenshotPath; clickPoint=$ClickX,$ClickY; mode=$Mode; borderRole=$borderRole; borderY=$borderY; borderWidth=$borderWidth."
    }
    catch {
        Write-Output "Desktop input diagnostics: screenshot=<failed: $($_.Exception.Message)>; clickPoint=$ClickX,$ClickY; mode=$Mode; borderRole=$borderRole; borderY=$borderY; borderWidth=$borderWidth."
    }
}

function New-ComposerPoint([int]$X, [int]$Y, [string]$Mode, [string]$BorderRole, [object]$BorderY, [object]$Width) {
    return [pscustomobject]@{
        X = $X
        Y = $Y
        Mode = $Mode
        BorderRole = $BorderRole
        BorderY = $BorderY
        Width = $Width
    }
}

function Test-ValidRatio([double]$Value) {
    return (-not [double]::IsNaN($Value) -and -not [double]::IsInfinity($Value) -and $Value -gt 0.02 -and $Value -lt 0.98)
}

function Get-CalibratedComposerClickPoint([RECT]$Rect) {
    $path = Get-DesktopInputCalibrationPath
    if (-not (Test-Path -LiteralPath $path)) {
        return $null
    }

    try {
        $calibration = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
        $xRatio = [double](Get-ObjectPropertyValue $calibration "xRatio" -1)
        $yRatio = [double](Get-ObjectPropertyValue $calibration "yRatio" -1)
        if (-not (Test-ValidRatio $xRatio) -or -not (Test-ValidRatio $yRatio)) {
            return $null
        }

        $width = $Rect.Right - $Rect.Left
        $height = $Rect.Bottom - $Rect.Top
        if ($width -le 0 -or $height -le 0) {
            return $null
        }

        $clickX = [int]($Rect.Left + ($width * $xRatio))
        $clickY = [int]($Rect.Top + ($height * $yRatio))
        return New-ComposerPoint $clickX $clickY "calibrated" "calibrated" "none" "none"
    }
    catch {
        Write-Verbose "Could not load desktop input calibration: $($_.Exception.Message)"
        return $null
    }
}

function Save-ComposerCalibration([RECT]$Rect, [object]$ComposerPoint) {
    if ($null -eq $ComposerPoint) {
        return
    }

    $mode = [string](Get-ObjectPropertyValue $ComposerPoint "Mode" "")
    if ($mode -ne "uia" -and $mode -ne "detected") {
        return
    }

    $width = $Rect.Right - $Rect.Left
    $height = $Rect.Bottom - $Rect.Top
    if ($width -le 0 -or $height -le 0) {
        return
    }

    $x = [double](Get-ObjectPropertyValue $ComposerPoint "X" -1)
    $y = [double](Get-ObjectPropertyValue $ComposerPoint "Y" -1)
    $xRatio = [Math]::Round(($x - $Rect.Left) / $width, 6)
    $yRatio = [Math]::Round(($y - $Rect.Top) / $height, 6)
    if (-not (Test-ValidRatio $xRatio) -or -not (Test-ValidRatio $yRatio)) {
        return
    }

    $path = Get-DesktopInputCalibrationPath
    $parent = Split-Path -Parent $path
    if (-not [string]::IsNullOrWhiteSpace($parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }

    [ordered]@{
        savedAt = (Get-Date).ToString("o")
        mode = $mode
        xRatio = $xRatio
        yRatio = $yRatio
        windowWidth = $width
        windowHeight = $height
    } | ConvertTo-Json | Set-Content -LiteralPath $path -Encoding UTF8
    Write-Output "Saved composer calibration: $path; xRatio=$xRatio; yRatio=$yRatio; mode=$mode."
}

function Find-UiAutomationComposerClickPoint([IntPtr]$Handle, [RECT]$Rect) {
    if (-not $script:UiAutomationAvailable) {
        return $null
    }

    try {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($Handle)
        if ($null -eq $root) {
            return $null
        }

        $windowWidth = $Rect.Right - $Rect.Left
        $windowHeight = $Rect.Bottom - $Rect.Top
        if ($windowWidth -le 0 -or $windowHeight -le 0) {
            return $null
        }

        $focusableCondition = New-Object System.Windows.Automation.PropertyCondition -ArgumentList ([System.Windows.Automation.AutomationElement]::IsKeyboardFocusableProperty), $true
        $enabledCondition = New-Object System.Windows.Automation.PropertyCondition -ArgumentList ([System.Windows.Automation.AutomationElement]::IsEnabledProperty), $true
        $condition = New-Object System.Windows.Automation.AndCondition -ArgumentList $focusableCondition, $enabledCondition
        $elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
        $candidates = New-Object System.Collections.Generic.List[object]

        for ($i = 0; $i -lt $elements.Count; $i += 1) {
            $element = $elements.Item($i)
            $bounds = $element.Current.BoundingRectangle
            if ($bounds.Width -le 0 -or $bounds.Height -le 0) {
                continue
            }
            if ([double]::IsInfinity($bounds.Width) -or [double]::IsInfinity($bounds.Height)) {
                continue
            }
            if ($bounds.Left -lt ($Rect.Left - 8) -or $bounds.Right -gt ($Rect.Right + 8)) {
                continue
            }
            if ($bounds.Top -lt ($Rect.Top + ($windowHeight * 0.52)) -or $bounds.Bottom -gt ($Rect.Bottom + 8)) {
                continue
            }
            if ($bounds.Width -lt [Math]::Max(260, [int]($windowWidth * 0.22))) {
                continue
            }
            if ($bounds.Height -lt 22 -or $bounds.Height -gt [Math]::Max(260, [int]($windowHeight * 0.36))) {
                continue
            }

            $controlType = ""
            $name = ""
            $automationId = ""
            try { $controlType = [string]$element.Current.ControlType.ProgrammaticName } catch { $controlType = "" }
            try { $name = [string]$element.Current.Name } catch { $name = "" }
            try { $automationId = [string]$element.Current.AutomationId } catch { $automationId = "" }

            $score = [double]$bounds.Width
            $score += (($bounds.Top - $Rect.Top) / [Math]::Max(1, $windowHeight)) * 240
            if ($controlType -match "Edit|Document|Text") {
                $score += 500
            }
            if (($name + " " + $automationId).ToLowerInvariant() -match "prompt|message|chat|compose|input|textbox") {
                $score += 300
            }

            $candidates.Add([pscustomobject]@{
                Left = [double]$bounds.Left
                Top = [double]$bounds.Top
                Width = [double]$bounds.Width
                Height = [double]$bounds.Height
                Score = $score
                ControlType = $controlType
            })
        }

        if ($candidates.Count -eq 0) {
            return $null
        }

        $best = $candidates | Sort-Object -Property Score, Top -Descending | Select-Object -First 1
        $clickX = [int]($best.Left + ($best.Width / 2))
        $clickOffset = [Math]::Min([Math]::Max(24, [int]($best.Height * 0.45)), [Math]::Max(8, [int]($best.Height - 8)))
        $clickY = [int]($best.Top + $clickOffset)
        return New-ComposerPoint $clickX $clickY "uia" "uia:$($best.ControlType)" ([int]$best.Top) ([int]$best.Width)
    }
    catch {
        Write-Verbose "UI Automation composer detection failed: $($_.Exception.Message)"
        return $null
    }
}

function Test-ComposerBorderPixel([System.Drawing.Color]$Color) {
    $max = [Math]::Max($Color.R, [Math]::Max($Color.G, $Color.B))
    $min = [Math]::Min($Color.R, [Math]::Min($Color.G, $Color.B))
    return ($Color.A -gt 0 -and ($max - $min) -le 14 -and $Color.R -ge 205 -and $Color.R -le 245)
}

function Find-LongestBorderRun([System.Drawing.Bitmap]$Bitmap, [int]$Y, [int]$MinX, [int]$MaxX) {
    $bestStart = -1
    $bestEnd = -1
    $runStart = -1
    $step = 2

    for ($x = $MinX; $x -le $MaxX; $x += $step) {
        if (Test-ComposerBorderPixel ($Bitmap.GetPixel($x, $Y))) {
            if ($runStart -lt 0) {
                $runStart = $x
            }
            continue
        }

        if ($runStart -ge 0) {
            $runEnd = $x - $step
            if (($runEnd - $runStart) -gt ($bestEnd - $bestStart)) {
                $bestStart = $runStart
                $bestEnd = $runEnd
            }
            $runStart = -1
        }
    }

    if ($runStart -ge 0) {
        $runEnd = $MaxX
        if (($runEnd - $runStart) -gt ($bestEnd - $bestStart)) {
            $bestStart = $runStart
            $bestEnd = $runEnd
        }
    }

    if ($bestStart -lt 0) {
        return $null
    }

    return [pscustomobject]@{
        Start = $bestStart
        End = $bestEnd
        Width = $bestEnd - $bestStart
        Center = [int](($bestStart + $bestEnd) / 2)
    }
}

function Find-ComposerClickPoint([IntPtr]$Handle, [RECT]$Rect) {
    $width = $Rect.Right - $Rect.Left
    $height = $Rect.Bottom - $Rect.Top
    if ($width -le 0 -or $height -le 0) {
        return $null
    }

    $bitmap = New-Object System.Drawing.Bitmap $width, $height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($Rect.Left, $Rect.Top, 0, 0, (New-Object System.Drawing.Size $width, $height))
        $minX = [int]($width * 0.18)
        $maxX = [int]($width * 0.90)
        $startY = [int]($height * 0.80)
        $endY = [int]($height * 0.96)
        $minRunWidth = [Math]::Max(320, [int]($width * 0.25))
        $candidates = New-Object System.Collections.Generic.List[object]

        for ($y = $startY; $y -le $endY; $y += 2) {
            $run = Find-LongestBorderRun $bitmap $y $minX $maxX
            if ($null -ne $run -and $run.Width -ge $minRunWidth) {
                $candidates.Add([pscustomobject]@{
                    Y = $y
                    Start = $run.Start
                    End = $run.End
                    Width = $run.Width
                    Center = $run.Center
                })
            }
        }

        if ($candidates.Count -eq 0) {
            return $null
        }

        $border = $candidates | Sort-Object Y | Select-Object -First 1
        $borderRole = if ($border.Y -gt [int]($height * 0.90)) { "bottom-border" } else { "top-border" }
        $clickX = $Rect.Left + $border.Center
        $clickYLocal = if ($borderRole -eq "bottom-border") {
            $border.Y - [Math]::Max(64, [int]($height * 0.07))
        }
        else {
            $border.Y + [Math]::Max(32, [int]($height * 0.035))
        }
        $clickYLocal = [Math]::Max([int]($height * 0.78), [Math]::Min($height - 90, $clickYLocal))
        $clickY = $Rect.Top + $clickYLocal
        return New-ComposerPoint ([int]$clickX) ([int]$clickY) "detected" $borderRole $border.Y $border.Width
    }
    finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

function Send-Key([byte]$VirtualKey) {
    [CodexDesktopWindow]::keybd_event($VirtualKey, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 35
    [CodexDesktopWindow]::keybd_event($VirtualKey, 0, 0x0002, [UIntPtr]::Zero)
}

function Send-CtrlV {
    [CodexDesktopWindow]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [CodexDesktopWindow]::keybd_event(0x56, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [CodexDesktopWindow]::keybd_event(0x56, 0, 0x0002, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [CodexDesktopWindow]::keybd_event(0x11, 0, 0x0002, [UIntPtr]::Zero)
}

function Verify-ClipboardText([string]$ExpectedText) {
    try {
        $actualText = [System.Windows.Forms.Clipboard]::GetText()
        if ($actualText -ne $ExpectedText) {
            throw "clipboard text mismatch"
        }
    }
    catch {
        throw "Clipboard verification failed: $($_.Exception.Message)"
    }
}

Enable-DpiAwareCoordinates

$resolvedPromptPath = (Resolve-Path -LiteralPath $PromptPath).Path
$text = Get-Content -LiteralPath $resolvedPromptPath -Raw -Encoding UTF8
$codexProcess = Get-Process -Name "Codex" -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Sort-Object StartTime -Descending |
    Select-Object -First 1

if (-not $codexProcess) {
    throw "Codex Desktop window was not found."
}

Focus-CodexDesktopWindow $codexProcess

Send-Key 0x1B
Start-Sleep -Milliseconds 150

$rect = New-Object RECT
if (-not [CodexDesktopWindow]::GetWindowRect($codexProcess.MainWindowHandle, [ref]$rect)) {
    throw "Could not read Codex Desktop window rectangle."
}

$composerPoint = Find-UiAutomationComposerClickPoint $codexProcess.MainWindowHandle $rect
if ($null -ne $composerPoint) {
    Write-Output "UI Automation composer click point: $($composerPoint.X),$($composerPoint.Y); borderRole=$($composerPoint.BorderRole); borderY=$($composerPoint.BorderY); width=$($composerPoint.Width)."
}

if ($null -eq $composerPoint) {
    $composerPoint = Get-CalibratedComposerClickPoint $rect
    if ($null -ne $composerPoint) {
        Write-Output "Calibrated composer click point: $($composerPoint.X),$($composerPoint.Y)."
    }
}

if ($null -eq $composerPoint) {
    $composerPoint = Find-ComposerClickPoint $codexProcess.MainWindowHandle $rect
    if ($null -ne $composerPoint) {
        Write-Output "Detected composer click point: $($composerPoint.X),$($composerPoint.Y); borderRole=$($composerPoint.BorderRole); borderY=$($composerPoint.BorderY); width=$($composerPoint.Width)."
    }
}

if ($null -eq $composerPoint) {
    $clickXRatio = Get-EnvDouble "CODEX_DESKTOP_INPUT_CLICK_X_RATIO" 0.5
    $clickYRatio = Get-EnvDouble "CODEX_DESKTOP_INPUT_CLICK_Y_RATIO" 0.92
    $clickX = [int]($rect.Left + (($rect.Right - $rect.Left) * $clickXRatio))
    $clickY = [int]($rect.Top + (($rect.Bottom - $rect.Top) * $clickYRatio))
    $composerPoint = New-ComposerPoint $clickX $clickY "fallback" "fallback" "none" "none"
    Write-Output "Using fallback composer click point: $clickX,$clickY."
}

$clickX = [int]$composerPoint.X
$clickY = [int]$composerPoint.Y
$clickMode = [string]$composerPoint.Mode
Capture-DesktopInputDiagnostics $rect $composerPoint $clickX $clickY $clickMode
Save-ComposerCalibration $rect $composerPoint

[void][CodexDesktopWindow]::SetCursorPos($clickX, $clickY)
Start-Sleep -Milliseconds 100
[CodexDesktopWindow]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
[CodexDesktopWindow]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 250
Verify-ForegroundProcess $codexProcess "after composer click"

if ($DetectOnly) {
    Write-Output "Detect-only mode; not pasting prompt."
    return
}

[System.Windows.Forms.Clipboard]::SetDataObject($text, $true, 10, 100)
Start-Sleep -Milliseconds 250
Verify-ClipboardText $text
Verify-ForegroundProcess $codexProcess "before paste"
Send-CtrlV
Start-Sleep -Milliseconds 500
Verify-ForegroundProcess $codexProcess "before submit"
Send-Key 0x0D

Write-Output "Sent prompt to Codex Desktop window $($codexProcess.Id)."
