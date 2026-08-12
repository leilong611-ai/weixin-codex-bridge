import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildConfigDiagnosticReport, buildConfigDiagnostics } from "../src/configDiagnostics.js";
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

  it("reports a safe first-run configuration without exposing peer IDs or tokens", () => {
    const config = {
      ...makeConfig("C:\\work\\project"),
      ownerPeerIds: ["wxid_secret_owner"],
      allowedPeerIds: ["wxid_secret_allowed"]
    };
    const report = buildConfigDiagnosticReport(config, {
      env: {},
      existsSync: () => true,
      nodeVersion: "22.18.0",
      validateWorkspace: () => ({
        allowedWorkspaceRoots: [],
        ok: true,
        reason: "ok",
        resolvedPath: config.codexCwd
      })
    });
    const output = JSON.stringify(report);

    expect(report.ok).toBe(true);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Node.js version", ok: true }),
      expect.objectContaining({ label: "Workspace security", ok: true }),
      expect.objectContaining({ label: "Sandbox policy", severity: "warn" }),
      expect.objectContaining({ label: "Role allowlists", ok: true }),
      expect.objectContaining({ label: "Default-deny", ok: true }),
      expect.objectContaining({ label: "Execution safety", ok: true }),
      expect.objectContaining({ label: "Privacy defaults", ok: true })
    ]));
    expect(output).not.toContain("wxid_secret_owner");
    expect(output).not.toContain("wxid_secret_allowed");
    expect(output).not.toContain(config.consoleToken);
  });

  it("reports actionable errors for an unsafe unconfigured checkout", () => {
    const config = {
      ...makeConfig("C:\\missing-project"),
      allowUnconfiguredDevMode: false
    };
    const report = buildConfigDiagnosticReport(config, {
      env: {},
      existsSync: () => false,
      nodeVersion: "20.19.0",
      validateWorkspace: () => ({
        allowedWorkspaceRoots: [],
        ok: false,
        reason: "Workspace is outside the sandbox root.",
        resolvedPath: config.codexCwd
      })
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Node.js version", ok: false, severity: "error" }),
      expect.objectContaining({ label: "Workspace security", ok: false, severity: "error" }),
      expect.objectContaining({ label: "Role allowlists", ok: false, severity: "error" })
    ]));
  });
});

function makeConfig(root: string): BridgeConfig {
  return {
    accountId: undefined,
    allowUnconfiguredDevMode: true,
    autoDesktopSession: false,
    codexCmdPath: path.join(root, "codex.cmd"),
    codexCwd: root,
    codexHome: path.join(root, ".codex"),
    codexModel: "gpt-5.4-mini",
    codexSessionId: undefined,
    cliFallbackEnabled: false,
    consoleEnabled: true,
    consolePort: 18790,
    consoleToken: "test-console-token",
    defaultDeny: true,
    deliveryMode: "desktop-ui",
    desktopInputScriptPath: path.join(root, "scripts", "Send-CodexDesktopInput.ps1"),
    desktopModelScriptPath: path.join(root, "scripts", "Set-CodexDesktopModel.ps1"),
    desktopResponseTimeoutMs: 900_000,
    logRoot: path.join(root, "state"),
    maxParallelRuns: 1,
    openclawConfigPath: path.join(root, ".openclaw", "openclaw.json"),
    openclawStateRoot: path.join(root, ".openclaw"),
    ownerPeerIds: [],
    allowedPeerIds: [],
    readonlyPeerIds: [],
    pollTimeoutMs: 35_000,
    resumeAllSessions: true,
    resumeLast: true,
    skipBacklogOnStart: true,
    weixinChannelVersion: "2.1.1",
    sandboxRoot: "",
    allowedWorkspaceRoots: [],
    executionMode: "restricted",
    allowFullAuto: false,
    allowSkipGitCheck: false,
    logLevel: "minimal",
    transcriptEnabled: false,
    storeFullPrompts: false,
    dataRetentionDays: 7,
  };
}
