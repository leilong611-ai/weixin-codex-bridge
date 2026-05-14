import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BridgeConfig } from "../src/config.js";
import { BridgeStateStore } from "../src/stateStore.js";

const tempRoots: string[] = [];

describe("BridgeStateStore", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("reports local sync state so restarts do not skip offline Weixin messages", async () => {
    const root = makeTempRoot();
    const config = makeConfig(root);
    writeSync(path.join(root, "bridge", "state", "account.sync.json"), "local-cursor");
    writeSync(path.join(root, "openclaw", "openclaw-weixin", "accounts", "account.sync.json"), "openclaw-cursor");

    await expect(new BridgeStateStore(config).loadSyncState("account")).resolves.toEqual({
      getUpdatesBuf: "local-cursor",
      source: "local"
    });
  });

  it("reports openclaw sync state when the bridge has no local cursor yet", async () => {
    const root = makeTempRoot();
    const config = makeConfig(root);
    writeSync(path.join(root, "openclaw", "openclaw-weixin", "accounts", "account.sync.json"), "openclaw-cursor");

    await expect(new BridgeStateStore(config).loadSyncState("account")).resolves.toEqual({
      getUpdatesBuf: "openclaw-cursor",
      source: "openclaw"
    });
  });

  it("persists a selected Codex conversation per Weixin session", async () => {
    const root = makeTempRoot();
    const config = makeConfig(root);
    const store = new BridgeStateStore(config);

    await store.saveSelectedCodexSession("weixin_session", "codex-session-id");

    await expect(store.loadSelectedCodexSession("weixin_session")).resolves.toBe("codex-session-id");
  });

  it("clears a selected Codex conversation", async () => {
    const root = makeTempRoot();
    const config = makeConfig(root);
    const store = new BridgeStateStore(config);
    await store.saveSelectedCodexSession("weixin_session", "codex-session-id");

    await store.clearSelectedCodexSession("weixin_session");

    await expect(store.loadSelectedCodexSession("weixin_session")).resolves.toBeUndefined();
  });

  it("persists the last normal prompt for retry", async () => {
    const root = makeTempRoot();
    const config = makeConfig(root);
    const store = new BridgeStateStore(config);

    await store.saveLastPrompt("weixin_session", "上一条微信消息");

    await expect(store.loadLastPrompt("weixin_session")).resolves.toBe("上一条微信消息");
  });

  it("takes a failed task by stable id", async () => {
    const root = makeTempRoot();
    const config = makeConfig(root);
    const store = new BridgeStateStore(config);
    await store.saveFailedTask({
      accountId: "account",
      error: "first",
      id: "failed-a",
      peerId: "wx-user",
      prompt: "first prompt",
      sessionKey: "weixin_session",
      timestamp: "2026-05-13T00:00:00.000Z"
    });
    await store.saveFailedTask({
      accountId: "account",
      error: "second",
      id: "failed-b",
      peerId: "wx-user",
      prompt: "second prompt",
      sessionKey: "weixin_session",
      timestamp: "2026-05-13T00:00:01.000Z"
    });

    await expect(store.takeFailedTaskById("weixin_session", "failed-b")).resolves.toMatchObject({
      prompt: "second prompt"
    });
    await expect(store.listFailedTasks("weixin_session")).resolves.toMatchObject([
      { id: "failed-a" }
    ]);
  });

  it("clears failed tasks only for the requested Weixin session", async () => {
    const root = makeTempRoot();
    const config = makeConfig(root);
    const store = new BridgeStateStore(config);
    await store.saveFailedTask({
      accountId: "account",
      error: "first",
      id: "failed-a",
      peerId: "wx-user",
      prompt: "first prompt",
      sessionKey: "weixin_session",
      timestamp: "2026-05-13T00:00:00.000Z"
    });
    await store.saveFailedTask({
      accountId: "account",
      error: "other",
      id: "failed-other",
      peerId: "wx-user",
      prompt: "other prompt",
      sessionKey: "other_session",
      timestamp: "2026-05-13T00:00:01.000Z"
    });

    await expect(store.clearFailedTasks("weixin_session")).resolves.toBe(1);
    await expect(store.listFailedTasks("weixin_session")).resolves.toEqual([]);
    await expect(store.listFailedTasks("other_session")).resolves.toMatchObject([
      { id: "failed-other" }
    ]);
    await expect(store.clearFailedTasks("weixin_session")).resolves.toBe(0);
  });

  it("archives failed tasks without leaving them active", async () => {
    const root = makeTempRoot();
    const config = makeConfig(root);
    const store = new BridgeStateStore(config);
    await store.saveFailedTask({
      accountId: "account",
      error: "first",
      id: "failed-a",
      peerId: "wx-user",
      prompt: "first prompt",
      sessionKey: "weixin_session",
      timestamp: "2026-05-13T00:00:00.000Z"
    });
    await store.saveFailedTask({
      accountId: "account",
      error: "other",
      id: "failed-other",
      peerId: "wx-user",
      prompt: "other prompt",
      sessionKey: "other_session",
      timestamp: "2026-05-13T00:00:01.000Z"
    });

    await expect(store.archiveFailedTasks("weixin_session")).resolves.toBe(1);

    await expect(store.listFailedTasks("weixin_session")).resolves.toEqual([]);
    await expect(store.listFailedTasks("other_session")).resolves.toMatchObject([
      { id: "failed-other" }
    ]);
    await expect(store.listArchivedFailedTasks("weixin_session")).resolves.toMatchObject([
      { id: "failed-a", prompt: "first prompt" }
    ]);
    await expect(store.archiveFailedTasks("weixin_session")).resolves.toBe(0);
  });

  it("includes selected Codex session ids in transcript summaries", async () => {
    const root = makeTempRoot();
    const config = makeConfig(root);
    const store = new BridgeStateStore(config);
    await store.appendMirrorEvent({
      accountId: "account",
      direction: "inbound",
      peerId: "wx-user",
      sessionKey: "weixin_session",
      text: "hello",
      timestamp: "2026-05-13T00:00:00.000Z"
    });
    await store.saveSelectedCodexSession("weixin_session", "codex-session-id");

    await expect(store.listTranscriptSummaries()).resolves.toMatchObject([
      { selectedCodexSessionId: "codex-session-id", sessionKey: "weixin_session" }
    ]);
  });
});

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "bridge-state-"));
  tempRoots.push(root);
  return root;
}

function makeConfig(root: string): BridgeConfig {
  return {
    autoDesktopSession: false,
    codexCmdPath: "codex.cmd",
    codexCwd: root,
    codexHome: path.join(root, ".codex"),
    codexModel: "gpt-5.4-mini",
    cliFallbackEnabled: false,
    consoleEnabled: false,
    consolePort: 18790,
    deliveryMode: "desktop-ui",
    desktopInputScriptPath: path.join(root, "Send-CodexDesktopInput.ps1"),
    desktopModelScriptPath: path.join(root, "Set-CodexDesktopModel.ps1"),
    desktopResponseTimeoutMs: 1000,
    logRoot: path.join(root, "bridge"),
    maxParallelRuns: 1,
    openclawConfigPath: path.join(root, "openclaw", "openclaw.json"),
    openclawStateRoot: path.join(root, "openclaw"),
    pollTimeoutMs: 1000,
    resumeAllSessions: true,
    resumeLast: true,
    skipBacklogOnStart: true,
    weixinChannelVersion: "2.1.1"
  };
}

function writeSync(filePath: string, getUpdatesBuf: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify({ get_updates_buf: getUpdatesBuf })}\n`, "utf8");
}
