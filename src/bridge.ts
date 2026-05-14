import { loadWeixinAccount } from "./accountStore.js";
import { randomUUID } from "node:crypto";
import { handleBridgeCommand, isBridgeCommandText } from "./bridgeCommand.js";
import type { BridgeConfig } from "./config.js";
import { buildCodexPrompt } from "./codexPrompt.js";
import { CodexRunner } from "./codexRunner.js";
import { DesktopUiRunner } from "./desktopUiRunner.js";
import { switchCodexDesktopModel, type DesktopModelSwitchResult } from "./desktopModel.js";
import { SessionTaskScheduler, type TaskSchedulerSnapshot } from "./messageScheduler.js";
import { splitWeixinReply } from "./replyText.js";
import { createSessionKey } from "./sessionKey.js";
import { BridgeStateStore } from "./stateStore.js";
import { MessageType, type BridgeRunResult, type CodexRunOptions, type WeixinAccount, type WeixinMessage } from "./types.js";
import { WeixinApi } from "./weixinApi.js";
import { extractWeixinText } from "./weixinText.js";

export class CodexWeixinBridge {
  private account?: WeixinAccount;
  private api?: WeixinApi;
  private readonly runner: {
    runExactPrompt(prompt: string, sessionKey: string, options?: CodexRunOptions): Promise<BridgeRunResult>;
  };
  private readonly fallbackRunner?: {
    runExactPrompt(prompt: string, sessionKey: string, options?: CodexRunOptions): Promise<BridgeRunResult>;
  };
  private readonly desktopModelSwitcher: (model: string) => Promise<DesktopModelSwitchResult>;
  private readonly scheduler: SessionTaskScheduler;
  private readonly state: BridgeStateStore;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(private readonly config: BridgeConfig) {
    this.runner = config.deliveryMode === "desktop-ui"
      ? new DesktopUiRunner(config)
      : new CodexRunner(config);
    this.fallbackRunner = config.deliveryMode === "desktop-ui" && config.cliFallbackEnabled
      ? new CodexRunner({
        ...config,
        codexSessionId: undefined,
        deliveryMode: "codex-cli",
        resumeAllSessions: false,
        resumeLast: false
      })
      : undefined;
    this.desktopModelSwitcher = (model) => switchCodexDesktopModel(config.desktopModelScriptPath, model);
    this.scheduler = new SessionTaskScheduler(config.deliveryMode === "desktop-ui"
      ? 1
      : config.maxParallelRuns);
    this.state = new BridgeStateStore(config);
  }

  async init(): Promise<void> {
    this.account = await loadWeixinAccount(this.config);
    this.api = new WeixinApi(this.config, this.account);
  }

  getTaskSnapshot(): TaskSchedulerSnapshot {
    return this.scheduler.snapshot();
  }

  async runForever(signal?: AbortSignal): Promise<void> {
    const account = this.requireAccount();
    const api = this.requireApi();
    const syncState = await this.state.loadSyncState(account.accountId);
    let syncBuf = syncState.getUpdatesBuf;
    let shouldSkipBacklog = this.config.skipBacklogOnStart && syncState.source !== "local";

    while (!signal?.aborted) {
      const response = await api.getUpdates(syncBuf, this.config.pollTimeoutMs);
      if ((response.ret ?? 0) !== 0 || (response.errcode ?? 0) !== 0) {
        throw new Error(`Weixin getUpdates failed: ret=${response.ret ?? 0} errcode=${response.errcode ?? 0} ${response.errmsg ?? ""}`.trim());
      }

      if (response.get_updates_buf) {
        syncBuf = response.get_updates_buf;
        await this.state.saveSyncBuf(account.accountId, syncBuf);
      }

      if (shouldSkipBacklog) {
        shouldSkipBacklog = false;
        if ((response.msgs ?? []).length > 0) {
          await this.state.appendMirrorEvent({
            accountId: account.accountId,
            direction: "system",
            peerId: "startup",
            sessionKey: "startup",
            text: `Skipped ${response.msgs?.length ?? 0} startup backlog message(s).`,
            timestamp: new Date().toISOString()
          });
          continue;
        }
      }

      for (const message of response.msgs ?? []) {
        this.trackBackgroundTask(this.processMessage(message));
      }
    }

    await Promise.allSettled(this.inFlight);
  }

  async processMessage(message: WeixinMessage): Promise<"processed" | "skipped"> {
    const account = this.requireAccount();
    const api = this.requireApi();
    if (message.message_type === MessageType.BOT) {
      return "skipped";
    }

    const peerId = message.from_user_id?.trim();
    if (!peerId) {
      return "skipped";
    }

    const text = extractWeixinText(message);
    const sessionKey = createSessionKey(account.accountId, peerId);
    if (!text) {
      await api.sendText({
        to: peerId,
        text: "这条消息不是文本内容，当前 Codex 微信桥暂时只接文本和语音转文字。",
        contextToken: message.context_token
      });
      return "skipped";
    }

    if (!isBridgeCommandText(text.trim())) {
      return await this.scheduler.schedule(
        sessionKey,
        async () => {
          await this.state.saveLastPrompt(sessionKey, text);
          await this.appendInboundMirror({
            accountId: account.accountId,
            message,
            peerId,
            sessionKey,
            text
          });
          return await this.runCodexAndReply({
            accountId: account.accountId,
            contextToken: message.context_token,
            messageId: message.message_id,
            peerId,
            promptText: text,
            sessionKey,
            weixinCreateTimeMs: message.create_time_ms
          });
        },
        { label: text.slice(0, 80) }
      );
    }

    await this.appendInboundMirror({
      accountId: account.accountId,
      message,
      peerId,
      sessionKey,
      text
    });

    const commandResult = await handleBridgeCommand(text, {
      config: this.config,
      sessionKey,
      state: this.state,
      taskSnapshot: this.scheduler.snapshot()
    });
    if (commandResult.action === "switch-desktop-model" && commandResult.desktopModel) {
      const replyText = await this.switchDesktopModelForWeixin(commandResult.desktopModel);
      await api.sendText({
        to: peerId,
        text: replyText,
        contextToken: message.context_token
      });
      await this.state.appendMirrorEvent({
        accountId: account.accountId,
        direction: "outbound",
        peerId,
        sessionKey,
        text: replyText,
        timestamp: new Date().toISOString()
      });
      return "processed";
    }

    if (commandResult.handled && !commandResult.promptText) {
      const replyText = commandResult.replyText ?? "";
      if (replyText) {
        await api.sendText({
          to: peerId,
          text: replyText,
          contextToken: message.context_token
        });
        await this.state.appendMirrorEvent({
          accountId: account.accountId,
          direction: "outbound",
          peerId,
          sessionKey,
          text: replyText,
          timestamp: new Date().toISOString()
        });
      }
      return "processed";
    }

    const promptText = commandResult.promptText ?? text;
    if (!commandResult.promptText) {
      await this.state.saveLastPrompt(sessionKey, text);
    }

    return await this.scheduler.schedule(
      sessionKey,
      () => this.runCodexAndReply({
        accountId: account.accountId,
        contextToken: message.context_token,
        messageId: message.message_id,
        peerId,
        promptText,
        sessionKey,
        weixinCreateTimeMs: message.create_time_ms
      }),
      { label: promptText.slice(0, 80) }
    );
  }

  private async switchDesktopModelForWeixin(model: string): Promise<string> {
    try {
      const result = await this.desktopModelSwitcher(model);
      if (result.exitCode === 0) {
        if (isVerifiedModelSwitch(result, model)) {
          return `已确认 Codex Desktop 模型：${model}`;
        }

        if (isMenuSelectedModelSwitch(result, model)) {
          return `已按菜单选择 Codex Desktop 模型：${model}`;
        }

        return [
          `已点击 Codex Desktop 模型切换，但未确认切换成功：${model}`,
          "请确认 Codex Desktop 当前空闲，并重试；如果仍失败，需要调模型选择器点击位置或识别方式。"
        ].join("\n");
      }

      const reason = (result.stderr || result.stdout).trim();
      return reason
        ? `Codex Desktop 模型切换失败：${reason}`
        : `Codex Desktop 模型切换失败，退出码：${result.exitCode ?? "unknown"}`;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return `Codex Desktop 模型切换失败：${reason}`;
    }
  }

  private async appendInboundMirror(params: {
    accountId: string;
    message: WeixinMessage;
    peerId: string;
    sessionKey: string;
    text: string;
  }): Promise<void> {
    await this.state.appendMirrorEvent({
      accountId: params.accountId,
      direction: "inbound",
      messageId: params.message.message_id,
      peerId: params.peerId,
      sessionKey: params.sessionKey,
      text: params.text,
      timestamp: new Date().toISOString(),
      weixinCreateTimeMs: params.message.create_time_ms
    });
  }

  private async runCodexAndReply(params: {
    accountId: string;
    contextToken?: string;
    messageId?: number | string;
    peerId: string;
    promptText: string;
    sessionKey: string;
    weixinCreateTimeMs?: number;
  }): Promise<"processed"> {
    const selectedSessionId = await this.state.loadSelectedCodexSession(params.sessionKey);
    const runOptions = selectedSessionId
      ? { codexSessionId: selectedSessionId, strictSession: true }
      : undefined;

    let replyText = "";
    let failureReason = "";
    let failureRunDirectory: string | undefined;
    try {
      const codexResult = await this.runner.runExactPrompt(buildCodexPrompt(params.promptText), params.sessionKey, runOptions);
      failureRunDirectory = codexResult.runDirectory;
      if (codexResult.ok && codexResult.lastMessage) {
        replyText = codexResult.lastMessage;
      } else {
        failureReason = (codexResult.stderr || codexResult.stdout || "Codex did not return a sendable message.").trim();
        replyText = "Codex Desktop 没有成功接收或完成这条消息，桥已继续运行。";
      }
    } catch (error) {
      replyText = "Codex Desktop 没有成功接收或完成这条消息，桥已继续运行。";
      failureReason = error instanceof Error ? error.message : String(error);
      await this.state.appendMirrorEvent({
        accountId: params.accountId,
        direction: "system",
        messageId: params.messageId,
        peerId: params.peerId,
        sessionKey: params.sessionKey,
        text: failureReason,
        timestamp: new Date().toISOString(),
        weixinCreateTimeMs: params.weixinCreateTimeMs
      });
    }

    if (failureReason && this.fallbackRunner) {
      const fallbackNoticeText = "Codex Desktop 暂时没有接收成功，已自动改用 Codex CLI 继续处理，请稍等。";
      await this.sendOutboundText({
        accountId: params.accountId,
        contextToken: params.contextToken,
        peerId: params.peerId,
        sessionKey: params.sessionKey,
        text: fallbackNoticeText
      });
      const fallbackResult = await this.runCliFallbackAfterDesktopFailure({
        accountId: params.accountId,
        desktopFailureReason: failureReason,
        messageId: params.messageId,
        peerId: params.peerId,
        promptText: params.promptText,
        runOptions: selectedSessionId ? runOptions : undefined,
        sessionKey: params.sessionKey,
        weixinCreateTimeMs: params.weixinCreateTimeMs
      });
      if (fallbackResult.ok) {
        failureReason = "";
        failureRunDirectory = fallbackResult.runDirectory;
        replyText = fallbackResult.replyText;
      } else {
        failureReason = fallbackResult.failureReason;
        failureRunDirectory = fallbackResult.runDirectory ?? failureRunDirectory;
      }
    }

    if (failureReason) {
      await this.state.saveFailedTask({
        accountId: params.accountId,
        error: failureReason,
        id: randomUUID(),
        messageId: params.messageId,
        peerId: params.peerId,
        prompt: params.promptText,
        runDirectory: failureRunDirectory,
        sessionKey: params.sessionKey,
        timestamp: new Date().toISOString(),
        weixinCreateTimeMs: params.weixinCreateTimeMs
      });
    }

    await this.sendOutboundText({
      accountId: params.accountId,
      contextToken: params.contextToken,
      peerId: params.peerId,
      sessionKey: params.sessionKey,
      text: replyText
    });

    return "processed";
  }

  private async sendOutboundText(params: {
    accountId: string;
    contextToken?: string;
    peerId: string;
    sessionKey: string;
    text: string;
  }): Promise<void> {
    const api = this.requireApi();
    for (const chunk of splitWeixinReply(params.text)) {
      await api.sendText({
        to: params.peerId,
        text: chunk,
        contextToken: params.contextToken
      });
      await this.state.appendMirrorEvent({
        accountId: params.accountId,
        direction: "outbound",
        peerId: params.peerId,
        sessionKey: params.sessionKey,
        text: chunk,
        timestamp: new Date().toISOString()
      });
    }
  }

  private async runCliFallbackAfterDesktopFailure(params: {
    accountId: string;
    desktopFailureReason: string;
    messageId?: number | string;
    peerId: string;
    promptText: string;
    runOptions?: CodexRunOptions;
    sessionKey: string;
    weixinCreateTimeMs?: number;
  }): Promise<{ failureReason: string; ok: false; runDirectory?: string } | { ok: true; replyText: string; runDirectory?: string }> {
    await this.state.appendMirrorEvent({
      accountId: params.accountId,
      direction: "system",
      messageId: params.messageId,
      peerId: params.peerId,
      sessionKey: params.sessionKey,
      text: `Desktop UI delivery failed; trying Codex CLI fallback. Reason: ${params.desktopFailureReason}`,
      timestamp: new Date().toISOString(),
      weixinCreateTimeMs: params.weixinCreateTimeMs
    });

    try {
      const fallbackResult = await this.fallbackRunner?.runExactPrompt(
        buildCodexPrompt(params.promptText),
        params.sessionKey,
        params.runOptions
      );
      if (fallbackResult?.ok && fallbackResult.lastMessage) {
        await this.state.appendMirrorEvent({
          accountId: params.accountId,
          direction: "system",
          messageId: params.messageId,
          peerId: params.peerId,
          sessionKey: params.sessionKey,
          text: "Codex CLI fallback succeeded after Desktop UI delivery failed.",
          timestamp: new Date().toISOString(),
          weixinCreateTimeMs: params.weixinCreateTimeMs
        });
        return {
          ok: true,
          replyText: fallbackResult.lastMessage,
          runDirectory: fallbackResult.runDirectory
        };
      }

      return {
        failureReason: [
          params.desktopFailureReason,
          (fallbackResult?.stderr || fallbackResult?.stdout || "Codex CLI fallback did not return a sendable message.").trim()
        ].filter(Boolean).join("\n"),
        ok: false,
        runDirectory: fallbackResult?.runDirectory
      };
    } catch (error) {
      return {
        failureReason: [
          params.desktopFailureReason,
          error instanceof Error ? error.message : String(error)
        ].filter(Boolean).join("\n"),
        ok: false
      };
    }
  }

  private trackBackgroundTask(task: Promise<unknown>): void {
    this.inFlight.add(task);
    void task
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        this.inFlight.delete(task);
      });
  }

  private requireAccount(): WeixinAccount {
    if (!this.account) {
      throw new Error("Bridge is not initialized. Call init() first.");
    }

    return this.account;
  }

  private requireApi(): WeixinApi {
    if (!this.api) {
      throw new Error("Bridge is not initialized. Call init() first.");
    }

    return this.api;
  }
}

function isVerifiedModelSwitch(result: DesktopModelSwitchResult, model: string): boolean {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return output.includes("verified") && output.includes(model.toLowerCase());
}

function isMenuSelectedModelSwitch(result: DesktopModelSwitchResult, model: string): boolean {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return output.includes("selected codex desktop model by menu") && output.includes(model.toLowerCase());
}
