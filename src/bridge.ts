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
import { SqliteStore, type StoredMessage } from "./sqliteStore.js";
import { makeMessageUid, makeAccountHash, makePeerHash } from "./messageIdentity.js";
import { preparePayload, payloadForRole, shouldStoreMessage, scrubPayload, MAX_MESSAGE_BYTES } from "./messagePayload.js";
import { MessageType, type BridgeRunResult, type CodexRunOptions, type WeixinAccount, type WeixinMessage } from "./types.js";
import { WeixinApi } from "./weixinApi.js";
import { extractWeixinText } from "./weixinText.js";
import {
  authorizePeer,
  classifyCommand,
  canUseCommand,
  type PeerAuthorization,
  REFUSAL_MESSAGE,
} from "./auth.js";
import { requireSecureWorkspace } from "./workspaceSecurity.js";

/**
 * Worker pool for processing durable inbox messages.
 * Manages lease tokens, heartbeat, and safe state transitions.
 */
class InboxWorkerPool {
  private readonly activeWorkers = new Map<number, {
    leaseToken: string;
    heartbeat: ReturnType<SqliteStore["startHeartbeat"]>;
  }>();

  constructor(
    private readonly sqlite: SqliteStore,
    private readonly processFn: (stored: import("./sqliteStore.js").StoredMessage) => Promise<void>,
  ) {}

  /**
   * Claim and process the next available message.
   * Starts a heartbeat for long-running operations.
   */
  async claimAndProcess(accountKey: string): Promise<boolean> {
    const claim = this.sqlite.claimNextMessage(accountKey);
    if (!claim) return false;

    const heartbeat = this.sqlite.startHeartbeat({
      id: claim.id,
      leaseToken: claim.leaseToken,
      owner: "bridge-worker",
    });

    this.activeWorkers.set(claim.id, { leaseToken: claim.leaseToken, heartbeat });

    try {
      const stored: StoredMessage = {
        id: claim.id,
        messageUid: claim.messageUid,
        accountKey,
        peerId: claim.peerId,
        rawJson: claim.payload?.rawJson ?? "",
        text: claim.text,
        status: "processing",
        createdAt: 0,
        leaseUntil: claim.leaseUntil,
        leaseToken: claim.leaseToken,
        attempts: claim.attempts,
        lastError: null,
        errorCategory: null,
        completedAt: null,
      };

      await this.processFn(stored);
    } finally {
      this.stopWorker(claim.id);
    }

    return true;
  }

  private stopWorker(id: number): void {
    const worker = this.activeWorkers.get(id);
    if (worker) {
      worker.heartbeat.stop();
      this.activeWorkers.delete(id);
    }
  }

  clear(): void {
    for (const [id] of this.activeWorkers) {
      this.stopWorker(id);
    }
  }

  get activeCount(): number {
    return this.activeWorkers.size;
  }
}

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
  private readonly sqlite: SqliteStore;
  private readonly inFlight = new Set<Promise<unknown>>();
  private workerPool!: InboxWorkerPool;
  private readonly cleanups: Array<() => void> = [];
  private _accountKey = "";

  constructor(private readonly config: BridgeConfig) {
    // Validate workspace security for non-high-risk mode
    if (config.executionMode !== "high-risk") {
      requireSecureWorkspace(config);
    }

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
    this.sqlite = new SqliteStore(config);
  }

  async init(): Promise<void> {
    this.account = await loadWeixinAccount(this.config);
    this.api = new WeixinApi(this.config, this.account);

    this._accountKey = makeAccountHash(this.account.accountId);

    // Initialize worker pool after account is known
    this.workerPool = new InboxWorkerPool(this.sqlite, async (stored) => {
      try {
        const message: WeixinMessage = JSON.parse(stored.rawJson);
        const result = await this.processMessage(message);
        if (result === "processed") {
          this.sqlite.completeMessage(stored.id, stored.leaseToken!);
        } else {
          this.sqlite.completeMessage(stored.id, stored.leaseToken!);
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.sqlite.failMessage(stored.id, stored.leaseToken!, errMsg);
      }
    });

    // Run data retention cleanup on startup
    try {
      const cleanupResult = this.sqlite.cleanupExpiredData();
      if (cleanupResult.deletedMessages > 0 || cleanupResult.deletedFailedTasks > 0) {
        console.log(
          `[codex-weixin] cleanup: ${cleanupResult.deletedMessages} message(s), ` +
          `${cleanupResult.deletedFailedTasks} failed task(s) removed`
        );
      }
    } catch {
      // Non-critical
    }
  }

  get accountKey(): string {
    return this._accountKey;
  }

  getTaskSnapshot(): TaskSchedulerSnapshot {
    return this.scheduler.snapshot();
  }

  async runForever(signal?: AbortSignal): Promise<void> {
    const account = this.requireAccount();
    const api = this.requireApi();
    const accountKey = this.accountKey;

    // Step 1: Recover expired leases
    const recovered = this.sqlite.recoverExpiredLeases(accountKey);
    if (recovered > 0) {
      console.log(`[codex-weixin] recovered ${recovered} stuck message(s) from SQLite inbox`);
    }

    // Step 2: Drain existing pending/failed messages BEFORE contacting WeChat API
    // This ensures crash recovery works even if WeChat API is temporarily down.
    await this.drainInbox(accountKey);

    // Step 3: Load cursor from SQLite (falls back to JSON sync state if empty)
    const syncState = await this.state.loadSyncState(account.accountId);
    let syncBuf = this.sqlite.loadSyncBuf(accountKey) || syncState.getUpdatesBuf;
    let shouldSkipBacklog = this.config.skipBacklogOnStart && syncState.source !== "local";

    // Step 4: Normal polling loop
    while (!signal?.aborted) {
      const response = await api.getUpdates(syncBuf, this.config.pollTimeoutMs);
      if ((response.ret ?? 0) !== 0 || (response.errcode ?? 0) !== 0) {
        throw new Error(`Weixin getUpdates failed: ret=${response.ret ?? 0} errcode=${response.errcode ?? 0} ${response.errmsg ?? ""}`.trim());
      }

      // ---- CRITICAL ORDER: batch inbox first, then cursor ----
      const persistMessages: Array<{
        messageUid: string;
        peerId: string;
        rawJson: string;
        text: string;
        createTimeMs?: number;
        statusOverride?: "skipped" | "rejected";
      }> = [];

      for (const message of response.msgs ?? []) {
        const messageUid = makeMessageUid({
          accountId: account.accountId,
          messageId: message.message_id,
          fromUserId: message.from_user_id,
          createTimeMs: message.create_time_ms,
          sessionId: message.session_id,
          text: extractWeixinText(message),
          contextToken: message.context_token,
        });

        const text = extractWeixinText(message);
        const peerId = message.from_user_id?.trim() ?? "";
        const isBot = message.message_type === MessageType.BOT;
        const logLevel = this.config.logLevel;

        // Prepare normalized payload
        const payload = preparePayload(
          JSON.stringify(message),
          text,
          message.message_type ?? 0,
          isBot,
          logLevel,
        );

        // Determine if we should store full content based on authorization
        const auth = peerId ? authorizePeer(peerId, this.config) : null;
        const role = auth?.role ?? "unknown";

        // For skipped backlog, minimize stored data
        if (shouldSkipBacklog) {
          persistMessages.push({
            messageUid,
            peerId: makePeerHash(peerId),
            rawJson: "",
            text: "",
            createTimeMs: message.create_time_ms,
            statusOverride: "skipped",
          });
          continue;
        }

        // Authorized content decision
        const content = payloadForRole(role, payload);

        // Check message size limit
        const oversized = payload.rawJson.length > MAX_MESSAGE_BYTES ||
          payload.text.length > MAX_MESSAGE_BYTES;

        persistMessages.push({
          messageUid,
          peerId: makePeerHash(peerId),
          rawJson: content.rawJson,
          text: content.text,
          createTimeMs: message.create_time_ms,
          statusOverride: oversized ? "rejected" : undefined,
        });
      }

      // Atomically persist the batch and update the cursor
      if (persistMessages.length > 0) {
        const batchResult = this.sqlite.persistFetchedBatch({
          accountKey,
          nextCursor: response.get_updates_buf ?? syncBuf,
          messages: persistMessages,
        });

        // Only update syncBuf after successful persistence
        if (response.get_updates_buf) {
          syncBuf = response.get_updates_buf;
        }

        if (shouldSkipBacklog) {
          shouldSkipBacklog = false;
          const backlogCount = batchResult.inserted + batchResult.skipped;
          console.log(`[codex-weixin] skipped ${backlogCount} startup backlog message(s)`);
          if (backlogCount > 0) {
            await this.state.appendMirrorEvent({
              accountId: account.accountId,
              direction: "system",
              peerId: "startup",
              sessionKey: "startup",
              text: `Skipped ${backlogCount} startup backlog message(s).`,
              timestamp: new Date().toISOString()
            });
          }
          // Skip processing for this cycle — backlog was just skipped
          continue;
        }
      } else if (response.get_updates_buf) {
        // No messages but cursor changed — still persist the cursor
        syncBuf = response.get_updates_buf;
        this.sqlite.saveSyncBuf(accountKey, syncBuf);
      }

      // Drain inbox: claim and process pending messages
      await this.drainInbox(accountKey);
    }

    await Promise.allSettled(this.inFlight);
    this.workerPool.clear();
    this.runCleanups();
  }

  /**
   * Drain inbox — process pending messages.
   * This is also called on startup BEFORE WeChat polling begins.
   */
  private async drainInbox(accountKey: string): Promise<void> {
    for (;;) {
      const claimed = await this.workerPool.claimAndProcess(accountKey);
      if (!claimed) break;
    }
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

    // ---- Authorization check ----
    const auth = authorizePeer(peerId, this.config);
    if (auth.role === "unknown") {
      await api.sendText({
        to: peerId,
        text: REFUSAL_MESSAGE,
        contextToken: message.context_token,
      });
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
      // Plain message — need at least "allowed" role
      if (auth.role === "readonly") {
        await api.sendText({
          to: peerId,
          text: "只读用户不能触发 Codex 执行。",
          contextToken: message.context_token,
        });
        return "skipped";
      }

      return await this.scheduler.schedule(
        sessionKey,
        async () => {
          if (this.config.storeFullPrompts) {
            await this.state.saveLastPrompt(sessionKey, text);
          }
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

    // Bridge command — authorize based on command classification
    const access = classifyCommand(text.trim());
    if (!canUseCommand(auth.role, access)) {
      await api.sendText({
        to: peerId,
        text: "这条管理命令需要更高的权限。",
        contextToken: message.context_token,
      });
      return "skipped";
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

  private runCleanups(): void {
    for (const cleanup of this.cleanups) {
      try { cleanup(); } catch { /* best-effort */ }
    }
    this.cleanups.length = 0;
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
