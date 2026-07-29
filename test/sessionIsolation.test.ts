import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

import { createSessionKey } from "../src/sessionKey.js";
import { BridgeStateStore } from "../src/stateStore.js";
import type { BridgeConfig } from "../src/config.js";

const tempRoots: string[] = [];

function makeConfig(root: string): BridgeConfig {
  return {
    accountId: undefined,
    allowUnconfiguredDevMode: true,
    autoDesktopSession: false,
    codexCmdPath: "codex.cmd",
    codexCwd: root,
    codexHome: path.join(root, ".codex"),
    codexModel: "gpt-5.4-mini",
    codexSessionId: undefined,
    cliFallbackEnabled: false,
    consoleEnabled: false,
    consolePort: 18790,
    consoleToken: "test",
    defaultDeny: true,
    deliveryMode: "desktop-ui",
    desktopInputScriptPath: "test.ps1",
    desktopModelScriptPath: "test.ps1",
    desktopResponseTimeoutMs: 1000,
    logRoot: path.join(root, "bridge"),
    maxParallelRuns: 1,
    openclawConfigPath: "openclaw.json",
    openclawStateRoot: path.join(root, "openclaw"),
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
    executionMode: "high-risk",
    allowFullAuto: false,
    allowSkipGitCheck: false,
    logLevel: "minimal",
    transcriptEnabled: false,
    storeFullPrompts: false,
    dataRetentionDays: 7,
  };
}

describe("session isolation", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("different peers get different session keys", () => {
    const keyA = createSessionKey("account1", "peer-a");
    const keyB = createSessionKey("account1", "peer-b");
    expect(keyA).not.toBe(keyB);
  });

  it("same peer gets the same session key", () => {
    const key1 = createSessionKey("account1", "peer-a");
    const key2 = createSessionKey("account1", "peer-a");
    expect(key1).toBe(key2);
  });

  it("user A cannot see user B's failed tasks", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "session-isolation-"));
    tempRoots.push(root);
    mkdirSync(path.join(root, "bridge", "state", "failed-tasks"), { recursive: true });
    const config = makeConfig(root);
    const store = new BridgeStateStore(config);

    await store.saveFailedTask({
      accountId: "account",
      error: "user b error",
      id: "task-b",
      peerId: "peer-b",
      prompt: "user b prompt",
      sessionKey: createSessionKey("account", "peer-b"),
      timestamp: new Date().toISOString(),
    });

    const userAFailures = await store.listFailedTasks(createSessionKey("account", "peer-a"));
    expect(userAFailures).toHaveLength(0);
  });

  it("user A's session key is deterministic per (account, peer)", () => {
    const key = createSessionKey("test-account", "test-peer");
    expect(key).toMatch(/^weixin_/);
    expect(key).not.toContain("@");
  });
});
