import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { handleBridgeCommand } from "../src/bridgeCommand.js";
import type { BridgeConfig } from "../src/config.js";
import { BridgeStateStore } from "../src/stateStore.js";

const tempRoots: string[] = [];

describe("handleBridgeCommand", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("formats recent Codex Desktop conversations for Weixin", async () => {
    const root = makeTempRoot();
    const config = makeConfig(root);
    writeSession(config.codexHome, "first", "C:\\Project A", "第一个需求", new Date("2026-05-05T10:00:00Z"));

    await expect(handleBridgeCommand("/对话", {
      config,
      sessionKey: "weixin_session",
      state: new BridgeStateStore(config)
    })).resolves.toMatchObject({
      handled: true,
      replyText: expect.stringContaining("1. 第一个需求")
    });
  });

  it("also accepts the bare Chinese conversation command without a slash", async () => {
    const root = makeTempRoot();
    const config = makeConfig(root);
    writeSession(config.codexHome, "first", "C:\\Project A", "第一个需求", new Date("2026-05-05T10:00:00Z"));

    await expect(handleBridgeCommand("对话", {
      config,
      sessionKey: "weixin_session",
      state: new BridgeStateStore(config)
    })).resolves.toMatchObject({
      handled: true,
      replyText: expect.stringContaining("1. 第一个需求")
    });
  });

  it("also accepts bare Chinese selection commands without a slash", async () => {
    const root = makeTempRoot();
    const config = makeConfig(root);
    writeSession(config.codexHome, "first", "C:\\Project A", "第一个需求", new Date("2026-05-05T10:00:00Z"));
    const state = new BridgeStateStore(config);

    await handleBridgeCommand("对话 1", {
      config,
      sessionKey: "weixin_session",
      state
    });

    await expect(state.loadSelectedCodexSession("weixin_session")).resolves.toBe("first");
  });

  it("selects a Codex Desktop conversation by list number", async () => {
    const root = makeTempRoot();
    const config = makeConfig(root);
    writeSession(config.codexHome, "first", "C:\\Project A", "第一个需求", new Date("2026-05-05T10:00:00Z"));
    writeSession(config.codexHome, "second", "C:\\Project B", "第二个需求", new Date("2026-05-06T10:00:00Z"));
    const state = new BridgeStateStore(config);

    const result = await handleBridgeCommand("/对话 2", {
      config,
      sessionKey: "weixin_session",
      state
    });

    expect(result).toMatchObject({
      handled: true,
      replyText: expect.stringContaining("已选择")
    });
    await expect(state.loadSelectedCodexSession("weixin_session")).resolves.toBe("first");
  });

  it("clears the selected conversation so Weixin follows the visible Codex window", async () => {
    const root = makeTempRoot();
    const config = makeConfig(root);
    const state = new BridgeStateStore(config);
    await state.saveSelectedCodexSession("weixin_session", "first");

    await expect(handleBridgeCommand("/对话 当前", {
      config,
      sessionKey: "weixin_session",
      state
    })).resolves.toMatchObject({
      handled: true,
      selectedSessionId: undefined,
      replyText: expect.stringContaining("当前 Codex 窗口")
    });
    await expect(state.loadSelectedCodexSession("weixin_session")).resolves.toBeUndefined();
  });

  it("accepts a follow-current prefix and sends only the remaining text to Codex", async () => {
    const root = makeTempRoot();
    const config = makeConfig(root);
    const state = new BridgeStateStore(config);
    await state.saveSelectedCodexSession("weixin_session", "first");

    await expect(handleBridgeCommand("对话当前 现在还有什么需要优化的", {
      config,
      sessionKey: "weixin_session",
      state
    })).resolves.toMatchObject({
      handled: true,
      promptText: "现在还有什么需要优化的"
    });
    await expect(state.loadSelectedCodexSession("weixin_session")).resolves.toBeUndefined();
  });

  it("reports bridge status", async () => {
    const root = makeTempRoot();
    const config = makeConfig(root);

    await expect(handleBridgeCommand("状态", {
      config,
      sessionKey: "weixin_session",
      state: new BridgeStateStore(config)
    })).resolves.toMatchObject({
      handled: true,
      replyText: expect.stringContaining("桥：运行中")
    });
  });

  it("reports task queue status", async () => {
    const root = makeTempRoot();
    const config = makeConfig(root);

    await expect(handleBridgeCommand("/任务", {
      config,
      sessionKey: "weixin_session",
      state: new BridgeStateStore(config),
      taskSnapshot: {
        activeCount: 1,
        maxParallel: 2,
        queuedCount: 3,
        sessions: [
          { active: true, queuedCount: 2, sessionKey: "account_peer-a" },
          { active: false, queuedCount: 1, sessionKey: "account_peer-b" }
        ]
      }
    })).resolves.toMatchObject({
      handled: true,
      replyText: expect.stringContaining("运行中：1/2")
    });
  });

  it("reports agent mode status", async () => {
    const root = makeTempRoot();
    const config = {
      ...makeConfig(root),
      deliveryMode: "codex-cli" as const,
      maxParallelRuns: 3
    };

    await expect(handleBridgeCommand("/代理", {
      config,
      sessionKey: "weixin_session",
      state: new BridgeStateStore(config),
      taskSnapshot: {
        activeCount: 0,
        maxParallel: 3,
        queuedCount: 0,
        sessions: []
      }
    })).resolves.toMatchObject({
      handled: true,
      replyText: expect.stringContaining("最大并行：3")
    });
  });

  it("returns a desktop model switch action for supported models", async () => {
    const root = makeTempRoot();
    const config = makeConfig(root);

    await expect(handleBridgeCommand("/桌面模型 gpt-5.4", {
      config,
      sessionKey: "weixin_session",
      state: new BridgeStateStore(config)
    })).resolves.toMatchObject({
      action: "switch-desktop-model",
      desktopModel: "gpt-5.4",
      handled: true,
      replyText: expect.stringContaining("正在切换")
    });
  });

  it("accepts no-space and bare desktop model switch commands", async () => {
    const root = makeTempRoot();
    const config = makeConfig(root);

    await expect(handleBridgeCommand("桌面模型5.4", {
      config,
      sessionKey: "weixin_session",
      state: new BridgeStateStore(config)
    })).resolves.toMatchObject({
      action: "switch-desktop-model",
      desktopModel: "gpt-5.4",
      handled: true
    });

    await expect(handleBridgeCommand("gpt5.4", {
      config,
      sessionKey: "weixin_session",
      state: new BridgeStateStore(config)
    })).resolves.toMatchObject({
      action: "switch-desktop-model",
      desktopModel: "gpt-5.4",
      handled: true
    });
  });

  it("rejects unsupported desktop model switch commands", async () => {
    const root = makeTempRoot();
    const config = makeConfig(root);

    await expect(handleBridgeCommand("/桌面模型 wrong-model", {
      config,
      sessionKey: "weixin_session",
      state: new BridgeStateStore(config)
    })).resolves.toMatchObject({
      handled: true,
      replyText: expect.stringContaining("不支持")
    });
  });

  it("reports the current conversation mode", async () => {
    const root = makeTempRoot();
    const config = makeConfig(root);
    const state = new BridgeStateStore(config);
    await state.saveSelectedCodexSession("weixin_session", "selected-session");

    await expect(handleBridgeCommand("当前", {
      config,
      sessionKey: "weixin_session",
      state
    })).resolves.toMatchObject({
      handled: true,
      replyText: expect.stringContaining("selected-session")
    });
  });

  it("returns the previous normal prompt for retry", async () => {
    const root = makeTempRoot();
    const config = makeConfig(root);
    const state = new BridgeStateStore(config);
    await state.saveLastPrompt("weixin_session", "上一条微信消息");

    await expect(handleBridgeCommand("重试", {
      config,
      sessionKey: "weixin_session",
      state
    })).resolves.toMatchObject({
      handled: true,
      promptText: "上一条微信消息"
    });
  });

  it("lists local bridge transcript records for the current Weixin session", async () => {
    const root = makeTempRoot();
    const config = makeConfig(root);
    const state = new BridgeStateStore(config);
    await state.appendMirrorEvent({
      accountId: "account",
      direction: "inbound",
      messageId: 1,
      peerId: "peer",
      sessionKey: "weixin_session",
      text: "微信原文没有落进 Codex 项目",
      timestamp: "2026-05-13T02:32:00.000Z"
    });
    await state.appendMirrorEvent({
      accountId: "account",
      direction: "system",
      messageId: 1,
      peerId: "peer",
      sessionKey: "weixin_session",
      text: "Timed out waiting for Codex Desktop to record the pasted prompt.",
      timestamp: "2026-05-13T02:32:19.000Z"
    });

    await expect(handleBridgeCommand("记录", {
      config,
      sessionKey: "weixin_session",
      state
    })).resolves.toMatchObject({
      handled: true,
      replyText: expect.stringContaining("微信原文没有落进 Codex 项目")
    });
  });

  it("filters local bridge transcript records by count or keyword", async () => {
    const root = makeTempRoot();
    const config = makeConfig(root);
    const state = new BridgeStateStore(config);
    for (const text of ["第一条", "模型失败", "第三条"]) {
      await state.appendMirrorEvent({
        accountId: "account",
        direction: "inbound",
        peerId: "peer",
        sessionKey: "weixin_session",
        text,
        timestamp: "2026-05-13T02:32:00.000Z"
      });
    }

    await expect(handleBridgeCommand("记录 2", {
      config,
      sessionKey: "weixin_session",
      state
    })).resolves.toMatchObject({
      replyText: expect.not.stringContaining("第一条")
    });

    const keywordResult = await handleBridgeCommand("记录 模型", {
      config,
      sessionKey: "weixin_session",
      state
    });
    expect(keywordResult.replyText).toContain("模型失败");
    expect(keywordResult.replyText).not.toContain("第三条");
  });

  it("lists, retries, and discards failed bridge tasks", async () => {
    const root = makeTempRoot();
    const config = makeConfig(root);
    const state = new BridgeStateStore(config);
    await state.saveFailedTask({
      accountId: "account",
      error: "Desktop UI did not record the prompt",
      id: "failed-a",
      messageId: 1,
      peerId: "peer",
      prompt: "需要重试的微信消息",
      sessionKey: "weixin_session",
      timestamp: "2026-05-13T02:32:00.000Z"
    });

    await expect(handleBridgeCommand("失败", {
      config,
      sessionKey: "weixin_session",
      state
    })).resolves.toMatchObject({
      replyText: expect.stringContaining("需要重试的微信消息")
    });

    await expect(handleBridgeCommand("重试 1", {
      config,
      sessionKey: "weixin_session",
      state
    })).resolves.toMatchObject({
      handled: true,
      promptText: "需要重试的微信消息"
    });
    await expect(state.listFailedTasks("weixin_session")).resolves.toHaveLength(0);

    await state.saveFailedTask({
      accountId: "account",
      error: "Still broken",
      id: "failed-b",
      peerId: "peer",
      prompt: "要丢弃的消息",
      sessionKey: "weixin_session",
      timestamp: "2026-05-13T02:33:00.000Z"
    });
    await expect(handleBridgeCommand("丢弃 1", {
      config,
      sessionKey: "weixin_session",
      state
    })).resolves.toMatchObject({
      replyText: expect.stringContaining("已丢弃")
    });
    await expect(state.listFailedTasks("weixin_session")).resolves.toHaveLength(0);
  });

  it("clears failed bridge tasks for the current Weixin session", async () => {
    const root = makeTempRoot();
    const config = makeConfig(root);
    const state = new BridgeStateStore(config);
    await state.saveFailedTask({
      accountId: "account",
      error: "Desktop UI did not record the prompt",
      id: "failed-a",
      peerId: "peer",
      prompt: "当前会话失败消息",
      sessionKey: "weixin_session",
      timestamp: "2026-05-13T02:32:00.000Z"
    });
    await state.saveFailedTask({
      accountId: "account",
      error: "Other session failure",
      id: "failed-other",
      peerId: "peer",
      prompt: "其他会话失败消息",
      sessionKey: "other_session",
      timestamp: "2026-05-13T02:33:00.000Z"
    });

    await expect(handleBridgeCommand("清空失败", {
      config,
      sessionKey: "weixin_session",
      state
    })).resolves.toMatchObject({
      handled: true,
      replyText: expect.stringContaining("1")
    });
    await expect(state.listFailedTasks("weixin_session")).resolves.toHaveLength(0);
    await expect(state.listFailedTasks("other_session")).resolves.toHaveLength(1);

    await state.saveFailedTask({
      accountId: "account",
      error: "Desktop UI did not record the prompt again",
      id: "failed-b",
      peerId: "peer",
      prompt: "当前会话第二条失败消息",
      sessionKey: "weixin_session",
      timestamp: "2026-05-13T02:34:00.000Z"
    });
    await expect(handleBridgeCommand("/清空失败", {
      config,
      sessionKey: "weixin_session",
      state
    })).resolves.toMatchObject({
      handled: true,
      replyText: expect.stringContaining("1")
    });
    await expect(state.listFailedTasks("weixin_session")).resolves.toHaveLength(0);
    await expect(state.listFailedTasks("other_session")).resolves.toHaveLength(1);
  });

  it("accepts English clear failure commands and reports when nothing can be cleared", async () => {
    const root = makeTempRoot();
    const config = makeConfig(root);
    const state = new BridgeStateStore(config);

    await expect(handleBridgeCommand("clear failed", {
      config,
      sessionKey: "weixin_session",
      state
    })).resolves.toMatchObject({
      handled: true,
      replyText: expect.stringContaining("没有可清空")
    });
    await expect(handleBridgeCommand("clear failures", {
      config,
      sessionKey: "weixin_session",
      state
    })).resolves.toMatchObject({
      handled: true,
      replyText: expect.stringContaining("没有可清空")
    });
  });

  it("archives failed bridge tasks for the current Weixin session", async () => {
    const root = makeTempRoot();
    const config = makeConfig(root);
    const state = new BridgeStateStore(config);
    await state.saveFailedTask({
      accountId: "account",
      error: "Desktop UI did not record the prompt",
      id: "failed-a",
      peerId: "peer",
      prompt: "archive me",
      sessionKey: "weixin_session",
      timestamp: "2026-05-13T02:32:00.000Z"
    });
    await state.saveFailedTask({
      accountId: "account",
      error: "Other session failure",
      id: "failed-other",
      peerId: "peer",
      prompt: "leave me active",
      sessionKey: "other_session",
      timestamp: "2026-05-13T02:33:00.000Z"
    });

    await expect(handleBridgeCommand("archive failures", {
      config,
      sessionKey: "weixin_session",
      state
    })).resolves.toMatchObject({
      handled: true,
      replyText: expect.stringContaining("1")
    });
    await expect(state.listFailedTasks("weixin_session")).resolves.toEqual([]);
    await expect(state.listFailedTasks("other_session")).resolves.toHaveLength(1);
    await expect(state.listArchivedFailedTasks("weixin_session")).resolves.toMatchObject([
      { prompt: "archive me" }
    ]);
  });

  it("includes the clear failures command in help text", async () => {
    const root = makeTempRoot();
    const config = makeConfig(root);

    await expect(handleBridgeCommand("帮助", {
      config,
      sessionKey: "weixin_session",
      state: new BridgeStateStore(config)
    })).resolves.toMatchObject({
      handled: true,
      replyText: expect.stringContaining("清空失败")
    });
  });

  it("reports diagnostics for the current bridge context", async () => {
    const root = makeTempRoot();
    const config = makeConfig(root);
    const state = new BridgeStateStore(config);
    await state.saveSelectedCodexSession("weixin_session", "selected-session");

    await expect(handleBridgeCommand("诊断", {
      config,
      sessionKey: "weixin_session",
      state,
      taskSnapshot: {
        activeCount: 0,
        maxParallel: 1,
        queuedCount: 0,
        sessions: []
      }
    })).resolves.toMatchObject({
      handled: true,
      replyText: expect.stringContaining("selected-session")
    });
  });

  it("handles cancel as a bridge command", async () => {
    const root = makeTempRoot();
    const config = makeConfig(root);

    await expect(handleBridgeCommand("取消", {
      config,
      sessionKey: "weixin_session",
      state: new BridgeStateStore(config)
    })).resolves.toMatchObject({
      handled: true,
      action: "cancel",
      replyText: expect.stringContaining("取消")
    });
  });
});

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "bridge-command-"));
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

function writeSession(codexHome: string, id: string, cwd: string, title: string, mtime: Date): void {
  const dir = path.join(codexHome, "sessions", "2026", "05", "05");
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-${id}.jsonl`);
  writeFileSync(filePath, `${[
    JSON.stringify({
      timestamp: mtime.toISOString(),
      type: "session_meta",
      payload: { id, cwd, originator: "Codex Desktop" }
    }),
    JSON.stringify({
      timestamp: mtime.toISOString(),
      type: "event_msg",
      payload: { type: "user_message", message: title }
    })
  ].join("\n")}\n`, "utf8");
  utimesSync(filePath, mtime, mtime);
}
