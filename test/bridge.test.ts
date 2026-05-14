import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CodexWeixinBridge } from "../src/bridge.js";
import type { BridgeConfig } from "../src/config.js";
import { createSessionKey } from "../src/sessionKey.js";
import { MessageItemType, MessageType, type WeixinAccount, type WeixinMessage } from "../src/types.js";

const tempRoots: string[] = [];

describe("CodexWeixinBridge", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("keeps a Desktop UI runner failure scoped to one Weixin message", async () => {
    const root = makeTempRoot();
    const bridge = new CodexWeixinBridge(makeConfig(root));
    const sentTexts: string[] = [];
    const bridgeInternals = bridge as unknown as {
      account: WeixinAccount;
      api: { sendText(params: { text: string }): Promise<string> };
      fallbackRunner?: { runExactPrompt(prompt: string, sessionKey: string): Promise<never> };
      runner: { runExactPrompt(prompt: string, sessionKey: string): Promise<never> };
    };
    bridgeInternals.account = { accountId: "account", baseUrl: "http://127.0.0.1/", token: "token" };
    bridgeInternals.api = {
      async sendText(params) {
        sentTexts.push(params.text);
        return "client-id";
      }
    };
    bridgeInternals.runner = {
      async runExactPrompt() {
        throw new Error("Desktop never recorded the pasted prompt");
      }
    };
    bridgeInternals.fallbackRunner = undefined;

    await expect(bridge.processMessage(makeTextMessage("微信原文"))).resolves.toBe("processed");

    expect(sentTexts).toEqual([
      "Codex Desktop 没有成功接收或完成这条消息，桥已继续运行。"
    ]);
  });

  it("stores failed Desktop UI deliveries for retry commands", async () => {
    const root = makeTempRoot();
    const bridge = new CodexWeixinBridge(makeConfig(root));
    const sentTexts: string[] = [];
    const bridgeInternals = bridge as unknown as {
      account: WeixinAccount;
      api: { sendText(params: { text: string }): Promise<string> };
      fallbackRunner?: { runExactPrompt(prompt: string, sessionKey: string): Promise<never> };
      runner: { runExactPrompt(prompt: string, sessionKey: string): Promise<never> };
      state: { listFailedTasks(sessionKey: string): Promise<Array<{ prompt: string }>> };
    };
    bridgeInternals.account = { accountId: "account", baseUrl: "http://127.0.0.1/", token: "token" };
    bridgeInternals.api = {
      async sendText(params) {
        sentTexts.push(params.text);
        return "client-id";
      }
    };
    bridgeInternals.runner = {
      async runExactPrompt() {
        throw new Error("Desktop never recorded the pasted prompt");
      }
    };
    bridgeInternals.fallbackRunner = undefined;

    await bridge.processMessage(makeTextMessage("失败后要保留"));

    await expect(bridgeInternals.state.listFailedTasks(createSessionKey("account", "wx-user"))).resolves.toMatchObject([
      { prompt: "失败后要保留" }
    ]);
    expect(sentTexts).toEqual([
      "Codex Desktop 没有成功接收或完成这条消息，桥已继续运行。"
    ]);
  });

  it("falls back to Codex CLI when Desktop UI delivery is not recorded", async () => {
    const root = makeTempRoot();
    const bridge = new CodexWeixinBridge(makeConfig(root));
    const sentTexts: string[] = [];
    const fallbackPrompts: string[] = [];
    const bridgeInternals = bridge as unknown as {
      account: WeixinAccount;
      api: { sendText(params: { text: string }): Promise<string> };
      fallbackRunner: { runExactPrompt(prompt: string, sessionKey: string): Promise<{ lastMessage: string; ok: boolean; runDirectory: string; stderr: string; stdout: string }> };
      runner: { runExactPrompt(prompt: string, sessionKey: string): Promise<never> };
      state: { listFailedTasks(sessionKey: string): Promise<Array<{ prompt: string }>> };
    };
    bridgeInternals.account = { accountId: "account", baseUrl: "http://127.0.0.1/", token: "token" };
    bridgeInternals.api = {
      async sendText(params) {
        sentTexts.push(params.text);
        return "client-id";
      }
    };
    bridgeInternals.runner = {
      async runExactPrompt() {
        throw new Error("Desktop never recorded the pasted prompt");
      }
    };
    bridgeInternals.fallbackRunner = {
      async runExactPrompt(prompt) {
        fallbackPrompts.push(prompt);
        return {
          lastMessage: "fallback reply",
          ok: true,
          runDirectory: root,
          stderr: "",
          stdout: ""
        };
      }
    };

    await bridge.processMessage(makeTextMessage("desktop busy message"));

    expect(fallbackPrompts).toEqual(["desktop busy message"]);
    expect(sentTexts).toEqual([
      "Codex Desktop 暂时没有接收成功，已自动改用 Codex CLI 继续处理，请稍等。",
      "fallback reply"
    ]);
    await expect(bridgeInternals.state.listFailedTasks(createSessionKey("account", "wx-user"))).resolves.toEqual([]);
  });

  it("stores a successful normal message so retry can resend it", async () => {
    const root = makeTempRoot();
    const bridge = new CodexWeixinBridge(makeConfig(root));
    const sentTexts: string[] = [];
    const bridgeInternals = bridge as unknown as {
      account: WeixinAccount;
      api: { sendText(params: { text: string }): Promise<string> };
      runner: { runExactPrompt(prompt: string, sessionKey: string): Promise<{ lastMessage: string; ok: boolean; runDirectory: string; stderr: string; stdout: string }> };
    };
    bridgeInternals.account = { accountId: "account", baseUrl: "http://127.0.0.1/", token: "token" };
    bridgeInternals.api = {
      async sendText(params) {
        sentTexts.push(params.text);
        return "client-id";
      }
    };
    bridgeInternals.runner = {
      async runExactPrompt(prompt) {
        return {
          lastMessage: `reply:${prompt}`,
          ok: true,
          runDirectory: root,
          stderr: "",
          stdout: ""
        };
      }
    };

    await bridge.processMessage(makeTextMessage("第一条"));
    await bridge.processMessage(makeTextMessage("重试"));

    expect(sentTexts).toEqual(["reply:第一条", "reply:第一条"]);
  });

  it("splits long Codex replies before sending them to Weixin", async () => {
    const root = makeTempRoot();
    const bridge = new CodexWeixinBridge(makeConfig(root));
    const sentTexts: string[] = [];
    const longReply = "A".repeat(3301);
    const bridgeInternals = bridge as unknown as {
      account: WeixinAccount;
      api: { sendText(params: { text: string }): Promise<string> };
      runner: { runExactPrompt(prompt: string, sessionKey: string): Promise<{ lastMessage: string; ok: boolean; runDirectory: string; stderr: string; stdout: string }> };
    };
    bridgeInternals.account = { accountId: "account", baseUrl: "http://127.0.0.1/", token: "token" };
    bridgeInternals.api = {
      async sendText(params) {
        sentTexts.push(params.text);
        return "client-id";
      }
    };
    bridgeInternals.runner = {
      async runExactPrompt() {
        return {
          lastMessage: longReply,
          ok: true,
          runDirectory: root,
          stderr: "",
          stdout: ""
        };
      }
    };

    await bridge.processMessage(makeTextMessage("长回复测试"));

    expect(sentTexts).toHaveLength(2);
    expect(sentTexts.join("")).toBe(longReply);
  });

  it("can run different Weixin peers through separate worker slots", async () => {
    const root = makeTempRoot();
    const bridge = new CodexWeixinBridge({
      ...makeConfig(root),
      deliveryMode: "codex-cli",
      maxParallelRuns: 2
    });
    const sentTexts: string[] = [];
    let active = 0;
    let maxActive = 0;
    const bridgeInternals = bridge as unknown as {
      account: WeixinAccount;
      api: { sendText(params: { text: string }): Promise<string> };
      runner: { runExactPrompt(prompt: string, sessionKey: string): Promise<{ lastMessage: string; ok: boolean; runDirectory: string; stderr: string; stdout: string }> };
    };
    bridgeInternals.account = { accountId: "account", baseUrl: "http://127.0.0.1/", token: "token" };
    bridgeInternals.api = {
      async sendText(params) {
        sentTexts.push(params.text);
        return "client-id";
      }
    };
    bridgeInternals.runner = {
      async runExactPrompt(prompt) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(20);
        active -= 1;
        return {
          lastMessage: `reply:${prompt}`,
          ok: true,
          runDirectory: root,
          stderr: "",
          stdout: ""
        };
      }
    };

    await Promise.all([
      bridge.processMessage(makeTextMessage("甲", "wx-user-a")),
      bridge.processMessage(makeTextMessage("乙", "wx-user-b"))
    ]);

    expect(maxActive).toBe(2);
    expect(sentTexts).toEqual(expect.arrayContaining(["reply:甲", "reply:乙"]));
  });

  it("exposes the live task snapshot for console agent status", async () => {
    const root = makeTempRoot();
    const bridge = new CodexWeixinBridge({
      ...makeConfig(root),
      deliveryMode: "codex-cli",
      maxParallelRuns: 2
    });
    let releaseRun = () => {};
    const bridgeInternals = bridge as unknown as {
      account: WeixinAccount;
      api: { sendText(params: { text: string }): Promise<string> };
      runner: { runExactPrompt(prompt: string, sessionKey: string): Promise<{ lastMessage: string; ok: boolean; runDirectory: string; stderr: string; stdout: string }> };
    };
    bridgeInternals.account = { accountId: "account", baseUrl: "http://127.0.0.1/", token: "token" };
    bridgeInternals.api = {
      async sendText() {
        return "client-id";
      }
    };
    const runStarted = new Promise<void>((resolve) => {
      bridgeInternals.runner = {
        async runExactPrompt(prompt) {
          resolve();
          await new Promise<void>((release) => {
            releaseRun = release;
          });
          return {
            lastMessage: `reply:${prompt}`,
            ok: true,
            runDirectory: root,
            stderr: "",
            stdout: ""
          };
        }
      };
    });

    const task = bridge.processMessage(makeTextMessage("agent-status", "wx-user-a"));
    await runStarted;

    expect((bridge as any).getTaskSnapshot()).toMatchObject({
      activeCount: 1,
      maxParallel: 2,
      queuedCount: 0
    });

    releaseRun();
    await task;
  });

  it("keeps messages from the same Weixin peer ordered even when submitted together", async () => {
    const root = makeTempRoot();
    const bridge = new CodexWeixinBridge({
      ...makeConfig(root),
      deliveryMode: "codex-cli",
      maxParallelRuns: 2
    });
    const sentTexts: string[] = [];
    const bridgeInternals = bridge as unknown as {
      account: WeixinAccount;
      api: { sendText(params: { text: string }): Promise<string> };
      runner: { runExactPrompt(prompt: string, sessionKey: string): Promise<{ lastMessage: string; ok: boolean; runDirectory: string; stderr: string; stdout: string }> };
    };
    bridgeInternals.account = { accountId: "account", baseUrl: "http://127.0.0.1/", token: "token" };
    bridgeInternals.api = {
      async sendText(params) {
        sentTexts.push(params.text);
        return "client-id";
      }
    };
    bridgeInternals.runner = {
      async runExactPrompt(prompt) {
        if (prompt === "第一条") {
          await sleep(20);
        }
        return {
          lastMessage: `reply:${prompt}`,
          ok: true,
          runDirectory: root,
          stderr: "",
          stdout: ""
        };
      }
    };

    await Promise.all([
      bridge.processMessage(makeTextMessage("第一条")),
      bridge.processMessage(makeTextMessage("第二条"))
    ]);

    expect(sentTexts).toEqual(["reply:第一条", "reply:第二条"]);
  });

  it("switches the Codex Desktop model for a desktop model command", async () => {
    const root = makeTempRoot();
    const bridge = new CodexWeixinBridge(makeConfig(root));
    const sentTexts: string[] = [];
    const switchedModels: string[] = [];
    const bridgeInternals = bridge as unknown as {
      account: WeixinAccount;
      api: { sendText(params: { text: string }): Promise<string> };
      desktopModelSwitcher: (model: string) => Promise<{ exitCode: number | null; stderr: string; stdout: string }>;
    };
    bridgeInternals.account = { accountId: "account", baseUrl: "http://127.0.0.1/", token: "token" };
    bridgeInternals.api = {
      async sendText(params) {
        sentTexts.push(params.text);
        return "client-id";
      }
    };
    bridgeInternals.desktopModelSwitcher = async (model) => {
      switchedModels.push(model);
      return {
        exitCode: 0,
        stderr: "",
        stdout: "Verified Codex Desktop model: gpt-5.4"
      };
    };

    await bridge.processMessage(makeTextMessage("/桌面模型 gpt-5.4"));

    expect(switchedModels).toEqual(["gpt-5.4"]);
    expect(sentTexts).toEqual(["已确认 Codex Desktop 模型：gpt-5.4"]);
  });

  it("does not report model switch success when the script only clicked", async () => {
    const root = makeTempRoot();
    const bridge = new CodexWeixinBridge(makeConfig(root));
    const sentTexts: string[] = [];
    const bridgeInternals = bridge as unknown as {
      account: WeixinAccount;
      api: { sendText(params: { text: string }): Promise<string> };
      desktopModelSwitcher: (model: string) => Promise<{ exitCode: number | null; stderr: string; stdout: string }>;
    };
    bridgeInternals.account = { accountId: "account", baseUrl: "http://127.0.0.1/", token: "token" };
    bridgeInternals.api = {
      async sendText(params) {
        sentTexts.push(params.text);
        return "client-id";
      }
    };
    bridgeInternals.desktopModelSwitcher = async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "Clicked Codex Desktop model picker."
    });

    await bridge.processMessage(makeTextMessage("/桌面模型 gpt-5.4"));

    expect(sentTexts[0]).toContain("未确认切换成功");
  });

  it("reports a menu-based desktop model selection separately from visual verification", async () => {
    const root = makeTempRoot();
    const bridge = new CodexWeixinBridge(makeConfig(root));
    const sentTexts: string[] = [];
    const bridgeInternals = bridge as unknown as {
      account: WeixinAccount;
      api: { sendText(params: { text: string }): Promise<string> };
      desktopModelSwitcher: (model: string) => Promise<{ exitCode: number | null; stderr: string; stdout: string }>;
    };
    bridgeInternals.account = { accountId: "account", baseUrl: "http://127.0.0.1/", token: "token" };
    bridgeInternals.api = {
      async sendText(params) {
        sentTexts.push(params.text);
        return "client-id";
      }
    };
    bridgeInternals.desktopModelSwitcher = async () => ({
        exitCode: 0,
        stderr: "",
        stdout: "Selected Codex Desktop model by menu: gpt-5.4"
    });

    await bridge.processMessage(makeTextMessage("/桌面模型 gpt-5.4"));

    expect(sentTexts).toEqual(["已按菜单选择 Codex Desktop 模型：gpt-5.4"]);
  });
});

function makeTextMessage(text: string, fromUserId = "wx-user"): WeixinMessage {
  return {
    from_user_id: fromUserId,
    message_id: 123,
    message_type: MessageType.USER,
    item_list: [{ type: MessageItemType.TEXT, text_item: { text } }]
  };
}

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "bridge-"));
  tempRoots.push(root);
  mkdirSync(path.join(root, "bridge"), { recursive: true });
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
