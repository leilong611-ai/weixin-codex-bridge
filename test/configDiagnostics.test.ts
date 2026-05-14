import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildConfigDiagnostics } from "../src/configDiagnostics.js";
import type { BridgeConfig } from "../src/config.js";

describe("buildConfigDiagnostics", () => {
  it("flags the paths most likely to break on a new computer", () => {
    const config = makeConfig("C:\\missing-project");
    const checks = buildConfigDiagnostics(config, {
      env: {},
      existsSync: () => false
    });

    expect(checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Codex workspace", ok: false, severity: "error" }),
      expect.objectContaining({ label: "Weixin account index", ok: false, severity: "error" }),
      expect.objectContaining({ label: "Desktop input script", ok: false, severity: "error" }),
      expect.objectContaining({ label: "Desktop model script", ok: false, severity: "error" })
    ]));
  });

  it("warns when desktop-ui is configured like a parallel CLI worker", () => {
    const config = {
      ...makeConfig("C:\\work\\project"),
      deliveryMode: "desktop-ui" as const,
      maxParallelRuns: 1
    };
    const checks = buildConfigDiagnostics(config, {
      env: { CODEX_WEIXIN_MAX_PARALLEL: "5" },
      existsSync: () => true
    });

    expect(checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        detail: expect.stringContaining("ignored"),
        label: "Desktop UI parallel setting",
        ok: false,
        severity: "warn"
      })
    ]));
  });

  it("requires a Codex command only when CLI delivery can be used", () => {
    const config = {
      ...makeConfig("C:\\work\\project"),
      cliFallbackEnabled: true
    };
    const checks = buildConfigDiagnostics(config, {
      env: {},
      existsSync: (candidate) => candidate !== config.codexCmdPath
    });

    expect(checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "Codex command",
        ok: false,
        severity: "error"
      })
    ]));
  });

  it("does not warn when legacy and current state roots are intentionally the same", () => {
    const config = makeConfig("C:\\work\\project");
    const checks = buildConfigDiagnostics(config, {
      env: {
        CODEX_WEIXIN_LOG_ROOT: config.logRoot,
        CODEX_WEIXIN_STATE_ROOT: config.logRoot
      },
      existsSync: () => true
    });

    expect(checks.some((check) => check.label === "State root precedence")).toBe(false);
  });
});

function makeConfig(root: string): BridgeConfig {
  return {
    autoDesktopSession: false,
    codexCmdPath: path.join(root, "codex.cmd"),
    codexCwd: root,
    codexHome: path.join(root, ".codex"),
    codexModel: "gpt-5.4-mini",
    cliFallbackEnabled: false,
    consoleEnabled: true,
    consolePort: 18790,
    deliveryMode: "desktop-ui",
    desktopInputScriptPath: path.join(root, "scripts", "Send-CodexDesktopInput.ps1"),
    desktopModelScriptPath: path.join(root, "scripts", "Set-CodexDesktopModel.ps1"),
    desktopResponseTimeoutMs: 900_000,
    logRoot: path.join(root, "state"),
    maxParallelRuns: 1,
    openclawConfigPath: path.join(root, ".openclaw", "openclaw.json"),
    openclawStateRoot: path.join(root, ".openclaw"),
    pollTimeoutMs: 35_000,
    resumeAllSessions: true,
    resumeLast: true,
    skipBacklogOnStart: true,
    weixinChannelVersion: "2.1.1"
  };
}
