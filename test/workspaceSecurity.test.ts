import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { BridgeConfig } from "../src/config.js";
import { requireSecureWorkspace, validateWorkspace } from "../src/workspaceSecurity.js";

describe("validateWorkspace", () => {
  function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
    const defaults: BridgeConfig = {
      accountId: undefined,
      allowUnconfiguredDevMode: true,
      autoDesktopSession: false,
      cliFallbackEnabled: false,
      codexCmdPath: "codex.cmd",
      codexCwd: "/tmp/test-workspace",
      codexHome: "/tmp/.codex",
      codexModel: "gpt-5.4-mini",
      codexSessionId: undefined,
      consoleEnabled: false,
      consolePort: 18790,
      consoleToken: "test",
      defaultDeny: true,
      deliveryMode: "desktop-ui",
      desktopInputScriptPath: "/tmp/test.ps1",
      desktopModelScriptPath: "/tmp/test.ps1",
      desktopResponseTimeoutMs: 1000,
      logRoot: "/tmp/bridge-state",
      maxParallelRuns: 1,
      openclawConfigPath: "/tmp/openclaw.json",
      openclawStateRoot: "/tmp/openclaw",
      ownerPeerIds: [],
      allowedPeerIds: [],
      readonlyPeerIds: [],
      pollTimeoutMs: 1000,
      resumeAllSessions: false,
      resumeLast: false,
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
      ...overrides,
    };
    return defaults;
  }

  it("rejects workspace pointing to home directory", () => {
    const config = makeConfig({ codexCwd: os.homedir() });
    const result = validateWorkspace(config);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("forbidden directory");
  });

  it("rejects workspace pointing to ~/.codex directory", () => {
    const codexDir = path.join(os.homedir(), ".codex");
    if (!fs.existsSync(codexDir)) {
      fs.mkdirSync(codexDir, { recursive: true });
    }
    const config = makeConfig({ codexCwd: codexDir });
    const result = validateWorkspace(config);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("forbidden directory");
  });

  it("rejects workspace pointing to ~/.ssh directory", () => {
    const sshDir = path.join(os.homedir(), ".ssh");
    const config = makeConfig({ codexCwd: sshDir });
    const result = validateWorkspace(config);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("forbidden directory");
  });

  it("rejects workspace outside sandbox root when sandboxRoot is set", () => {
    const testId = `ws-sandbox-${Date.now()}`;
    const testRoot = makeWorkspaceTestRoot(testId);
    const sandboxDir = path.join(testRoot, "sandbox");
    const outsideDir = path.join(testRoot, "outside");
    fs.mkdirSync(sandboxDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    try {
      const config = makeConfig({
        codexCwd: outsideDir,
        sandboxRoot: sandboxDir,
      });
      const result = validateWorkspace(config);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("sandbox root");
    } finally {
      fs.rmSync(testRoot, { force: true, recursive: true });
    }
  });

  it("fails closed when restricted mode has no explicit workspace boundary", () => {
    const testRoot = makeWorkspaceTestRoot(`ws-unbounded-${Date.now()}`);
    fs.mkdirSync(testRoot, { recursive: true });
    try {
      const result = validateWorkspace(makeConfig({
        allowedWorkspaceRoots: [],
        codexCwd: testRoot,
        sandboxRoot: ""
      }));
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("requires CODEX_WEIXIN_SANDBOX_ROOT");
    } finally {
      fs.rmSync(testRoot, { force: true, recursive: true });
    }
  });

  it("rejects a workspace symlink or Windows junction that escapes the real sandbox", () => {
    const testRoot = makeWorkspaceTestRoot(`ws-symlink-${Date.now()}`);
    const sandboxDir = path.join(testRoot, "sandbox");
    const outsideDir = path.join(testRoot, "outside");
    const linkDir = path.join(sandboxDir, "linked-project");
    fs.mkdirSync(sandboxDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideDir, linkDir, process.platform === "win32" ? "junction" : "dir");
    try {
      const result = validateWorkspace(makeConfig({ codexCwd: linkDir, sandboxRoot: sandboxDir }));
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("outside the sandbox root");
    } finally {
      fs.rmSync(testRoot, { force: true, recursive: true });
    }
  });

  it("preserves POSIX path case while checking containment", () => {
    if (process.platform !== "linux") {
      return;
    }
    const testRoot = makeWorkspaceTestRoot(`ws-case-${Date.now()}`);
    const allowedDir = path.join(testRoot, "Safe");
    const outsideDir = path.join(testRoot, "safe", "project");
    fs.mkdirSync(allowedDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    try {
      const result = validateWorkspace(makeConfig({
        allowedWorkspaceRoots: [allowedDir],
        codexCwd: outsideDir,
        sandboxRoot: ""
      }));
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("allowed workspace root");
    } finally {
      fs.rmSync(testRoot, { force: true, recursive: true });
    }
  });

  it("rejects a missing workspace instead of skipping realpath validation", () => {
    const testRoot = makeWorkspaceTestRoot(`ws-missing-${Date.now()}`);
    fs.mkdirSync(testRoot, { recursive: true });
    try {
      const missing = path.join(testRoot, "missing");
      const result = validateWorkspace(makeConfig({ codexCwd: missing, sandboxRoot: testRoot }));
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("does not resolve to an existing path");
    } finally {
      fs.rmSync(testRoot, { force: true, recursive: true });
    }
  });

  it("allows workspace inside sandbox root", () => {
    const testId = `ws-inside-${Date.now()}`;
    const testRoot = makeWorkspaceTestRoot(testId);
    const sandboxDir = path.join(testRoot, "sandbox");
    const insideDir = path.join(sandboxDir, "project");
    fs.mkdirSync(insideDir, { recursive: true });

    try {
      const config = makeConfig({
        codexCwd: insideDir,
        sandboxRoot: sandboxDir,
      });
      const result = validateWorkspace(config);
      expect(result.ok).toBe(true);
    } finally {
      fs.rmSync(testRoot, { force: true, recursive: true });
    }
  });

  it("rejects workspace not in any allowedWorkspaceRoots", () => {
    const testId = `ws-allowed-${Date.now()}`;
    const testRoot = makeWorkspaceTestRoot(testId);
    const allowedDir = path.join(testRoot, "allowed");
    const outsideDir = path.join(testRoot, "outside");
    fs.mkdirSync(allowedDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    try {
      const config = makeConfig({
        codexCwd: outsideDir,
        allowedWorkspaceRoots: [allowedDir],
      });
      const result = validateWorkspace(config);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("allowed workspace root");
    } finally {
      fs.rmSync(testRoot, { force: true, recursive: true });
    }
  });

  it("allows workspace in an allowedWorkspaceRoot", () => {
    const testId = `ws-allowed-inside-${Date.now()}`;
    const testRoot = makeWorkspaceTestRoot(testId);
    const projectDir = path.join(testRoot, "project");
    fs.mkdirSync(projectDir, { recursive: true });

    try {
      const config = makeConfig({
        codexCwd: projectDir,
        allowedWorkspaceRoots: [testRoot],
      });
      const result = validateWorkspace(config);
      expect(result.ok).toBe(true);
    } finally {
      fs.rmSync(testRoot, { force: true, recursive: true });
    }
  });

  it("accepts a safe workspace", () => {
    const testId = `ws-safe-${Date.now()}`;
    const testRoot = makeWorkspaceTestRoot(testId);
    const projectDir = path.join(testRoot, "safe-project");
    fs.mkdirSync(projectDir, { recursive: true });

    try {
      const config = makeConfig({
        codexCwd: projectDir,
        sandboxRoot: testRoot,
      });
      const result = validateWorkspace(config);
      expect(result.ok).toBe(true);
    } finally {
      fs.rmSync(testRoot, { force: true, recursive: true });
    }
  });

  it("skips validation in high-risk mode", () => {
    const config = makeConfig({
      codexCwd: os.homedir(),
      executionMode: "high-risk",
    });
    expect(() => requireSecureWorkspace(config)).not.toThrow();
  });
});

function makeWorkspaceTestRoot(testId: string): string {
  // ponytail: process.cwd() is safe on GitHub's Windows runner; use a configurable non-forbidden root if local Windows checkout paths need support.
  const base = process.platform === "win32" ? process.cwd() : os.tmpdir();
  return path.join(base, `.workspace-security-${testId}`);
}
