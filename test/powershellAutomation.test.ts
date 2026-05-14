import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(__dirname, "..");

function readScript(name: string): string {
  return fs.readFileSync(path.join(projectRoot, "scripts", name), "utf8");
}

describe("desktop PowerShell automation scripts", () => {
  it("keeps the setup preflight script UTF-8 BOM encoded for Windows PowerShell Chinese output", () => {
    const bytes = fs.readFileSync(path.join(projectRoot, "scripts", "Test-CodexWeixinSetup.ps1"));

    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("focuses Codex Desktop without restoring a maximized window before sending input", () => {
    const script = readScript("Send-CodexDesktopInput.ps1");

    expect(script).toContain("IsIconic");
    expect(script).toContain("Focus-CodexDesktopWindow");
    expect(script).toContain("ShowWindowWithoutResizing");
    expect(script).toContain("AttachThreadInput");
    expect(script).toContain("BringWindowToTop");
    expect(script).toContain("Find-ComposerClickPoint");
    expect(script).toContain("Enable-DpiAwareCoordinates");
    expect(script).toContain("SetProcessDpiAwarenessContext");
    expect(script).toContain("System.Windows.Automation");
    expect(script).toContain("Find-UiAutomationComposerClickPoint");
    expect(script).toContain("IsKeyboardFocusableProperty");
    expect(script).toContain("Get-CalibratedComposerClickPoint");
    expect(script).toContain("CODEX_DESKTOP_INPUT_CALIBRATION_PATH");
    expect(script).toContain("Save-ComposerCalibration");
    expect(script).toContain("Verify-ClipboardText");
    expect(script).toContain("Verify-ForegroundProcess");
    expect(script).toContain("Detected composer click point");
    expect(script).toContain("UI Automation composer click point");
    expect(script).toContain("Calibrated composer click point");
    expect(script).toContain("Saved composer calibration");
    expect(script).toContain("Clipboard verification failed");
    expect(script).toContain("bottom-border");
    expect(script).toContain("borderRole");
    expect(script).toContain("CODEX_DESKTOP_INPUT_DEBUG_DIR");
    expect(script).toContain("D:\\OpenClawWorkspace\\tmp\\codex-weixin-bridge\\debug");
    expect(script).toContain("Save-WindowScreenshot");
    expect(script).toContain("Capture-DesktopInputDiagnostics");
    expect(script).toContain("[System.Drawing.Imaging.ImageFormat]::Png");
    expect(script).toContain("Desktop input diagnostics:");
    expect(script).toContain("screenshot=");
    expect(script).toContain("clickPoint=");
    expect(script).toContain("mode=");
    expect(script).toContain("borderRole=");
    expect(script).toContain("[switch]$DetectOnly");
    expect(script).toContain("Detect-only mode; not pasting prompt.");
    expect(script).toContain("Using fallback composer click point");
    expect(script).toContain('Get-EnvDouble "CODEX_DESKTOP_INPUT_CLICK_X_RATIO" 0.5');
    expect(script).toContain('Get-EnvDouble "CODEX_DESKTOP_INPUT_CLICK_Y_RATIO" 0.92');
    expect(script).toContain("keybd_event");
    expect(script).toContain("Send-CtrlV");
    expect(script).toContain("SetDataObject");
    expect(script).not.toContain('SendWait("^a")');
    expect(script).not.toContain('SendKeys("^v")');
    expect(script).not.toContain("SendWait(\"^v\")");
  });

  it("focuses Codex Desktop without restoring a maximized window before switching models", () => {
    const script = readScript("Set-CodexDesktopModel.ps1");

    expect(script).toContain("IsIconic");
    expect(script).toContain("Focus-CodexDesktopWindow");
    expect(script).toContain("ShowWindowWithoutResizing");
    expect(script).toContain("AttachThreadInput");
    expect(script).toContain("BringWindowToTop");
    expect(script).toContain('Get-EnvDouble "CODEX_DESKTOP_MODEL_CLICK_X_RATIO" 0.69');
    expect(script).toContain('Get-EnvDouble "CODEX_DESKTOP_MODEL_CLICK_Y_RATIO" 0.935');
    expect(script).toContain("Select-CodexDesktopModelFromMenu");
    expect(script).toContain('"gpt-5.4-mini"');
    expect(script).toContain('"gpt-5.3-codex-spark"');
  });

  it("provides a companion launcher that starts Codex and stops the bridge when Codex exits", () => {
    const script = readScript("Start-CodexWithWeixinBridge.ps1");
    const hiddenLauncher = readScript("Launch-CodexWithWeixinBridge-Hidden.vbs");
    const shortcutInstaller = readScript("Install-CodexWeixinCompanionShortcut.ps1");

    expect(script).toContain("Start-CodexWeixinBridge.ps1");
    expect(script).toContain("Status-CodexWeixinBridge.ps1");
    expect(script).toContain("Resolve-CodexDesktopLaunchTarget");
    expect(script).toContain("Get-StartApps");
    expect(script).toContain("CODEX_DESKTOP_APP_ID");
    expect(script).toContain("$CodexAppId");
    expect(script).toContain("Could not find Codex Desktop");
    expect(script).not.toContain("OpenAI.Codex_2p2nqsd0c76g0!App");
    expect(script).toContain("shell:AppsFolder");
    expect(script).toContain("Wait-CodexDesktopWindow");
    expect(script).toContain("Stop-Bridge");
    expect(script).toContain("finally");
    expect(script).toContain("Stop-Process -Id");
    expect(script).toContain("MainWindowHandle");
    expect(script).toContain("MonitorIntervalSeconds");
    expect(script).toContain("Get-ExistingCompanionProcess");
    expect(script).toContain("already-bound");
    expect(script).toContain("ProcessId -ne $PID");
    expect(script).toContain("$existingCompanions = @(Get-ExistingCompanionProcess)");
    expect(script).toContain("$existing = @(Get-CodexDesktopWindow)");
    expect(script).toContain("$window = @(Get-CodexDesktopWindow)");
    expect(script.indexOf("if ($existingCompanions.Count -gt 0)")).toBeLessThan(script.indexOf("try {"));

    expect(hiddenLauncher).toContain('CreateObject("WScript.Shell")');
    expect(hiddenLauncher).toContain("Start-CodexWithWeixinBridge.ps1");
    expect(hiddenLauncher).toContain("shell.Run cmd, 0, False");
    expect(hiddenLauncher).not.toContain('CreateObject(""WScript.Shell"")');

    expect(shortcutInstaller).toContain("Launch-CodexWithWeixinBridge-Hidden.vbs");
    expect(shortcutInstaller).toContain("Codex + Weixin Bridge.lnk");
    expect(shortcutInstaller).toContain("WScript.Shell");
  });

  it("keeps the local PowerShell bridge chain on the explicit D-drive state root", () => {
    const start = readScript("Start-CodexWeixinBridge.ps1");
    const status = readScript("Status-CodexWeixinBridge.ps1");
    const watch = readScript("Watch-CodexWeixinBridge.ps1");
    const companion = readScript("Start-CodexWithWeixinBridge.ps1");
    const defaultStateRoot = '[string]$StateRoot = "D:\\OpenClawWorkspace\\tmp\\codex-weixin-bridge"';

    expect(start).toContain(defaultStateRoot);
    expect(status).toContain(defaultStateRoot);
    expect(watch).toContain(defaultStateRoot);
    expect(companion).toContain(defaultStateRoot);

    expect(start).toContain('$env:CODEX_WEIXIN_STATE_ROOT = $StateRoot');
    expect(start).toContain('$env:CODEX_WEIXIN_LOG_ROOT = $StateRoot');
    expect(watch).toContain("-StateRoot $StateRoot");
    expect(watch).toContain('"-StateRoot", $StateRoot');
    expect(companion).toContain("-StateRoot $StateRoot");
    expect(companion).toContain('"-StateRoot", $StateRoot');
  });

  it("provides a setup preflight script for machine-specific bridge configuration", () => {
    const script = readScript("Test-CodexWeixinSetup.ps1");
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));

    expect(script).toContain("CODEX_WEIXIN_CWD");
    expect(script).toContain("CODEX_WEIXIN_STATE_ROOT");
    expect(script).toContain("OPENCLAW_STATE_DIR");
    expect(script).toContain("CODEX_WEIXIN_DELIVERY_MODE");
    expect(script).toContain("CODEX_WEIXIN_CONSOLE_PORT");
    expect(script).toContain("CODEX_DESKTOP_APP_ID");
    expect(script).toContain("Get-StartApps");
    expect(script).toContain("Get-NetTCPConnection");
    expect(script).toContain("openclaw-weixin\\accounts.json");
    expect(script).toContain("dist\\cli.js");
    expect(script).toContain("Send-CodexDesktopInput.ps1");
    expect(script).toContain("Set-CodexDesktopModel.ps1");
    expect(script).toContain("http://127.0.0.1:");
    expect(script).toContain("consoleSummary");
    expect(script).toContain("configRiskCount");
    expect(script).toContain("suggestedEnv");
    expect(script).toContain("checks");
    expect(script).toContain("ConvertTo-Json");
    expect(script).toContain("does not write credentials");
    expect(script).toContain("Codex 微信桥本机预检");
    expect(script).toContain("状态=$($result.ok) 错误=$errorCount 警告=$warningCount");
    expect(script).toContain("修复建议:");
    expect(script).toContain("建议环境变量:");
    expect(script).not.toContain("consoleStatus         = $consoleStatus");
    expect(script).not.toContain("Codex Weixin bridge setup preflight");
    expect(script).not.toContain("Suggested environment values:");
    expect(pkg.scripts["setup-check"]).toContain("Test-CodexWeixinSetup.ps1");
  });
});
