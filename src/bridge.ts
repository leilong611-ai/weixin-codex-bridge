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
import { SqliteStore } from "./sqliteStore.js";
import {
  makeMessageUid, makeAccountHash, makePeerHash,
} from "./messageIdentity.js";
import {
  preparePayload, payloadForRole, MAX_MESSAGE_BYTES,
} from "./messagePayload.js";
import {
  buildEnvelope, parseEnvelope, classifyInboundMessage,
  type DurableMessageEnvelopeV1, type InboundDecision,
  MAX_INBOUND_MESSAGE_BYTES,
} from "./messageEnvelope.js";
import { StoragePolicy, type StoragePolicyConfig } from "./storagePolicy.js";
import { redactText } from "./redact.js";
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_QUEUED_PER_PEER = 10;
const MAX_DB_PENDING = 100;

// ---------------------------------------------------------------------------
// Worker pool — bounded concurrency with per-peer ordering
// ---------------------------------------------------------------------------

class InboxWorkerPool {
  private readonly activeWorkers = new Map<number, {
    leaseToken: string;
    heartbeat: ReturnType<SqliteStore["startHeartbeat"]>;
    abortController: AbortController;
  }>();

  /** Track running count per peer for ordering enforcement */
  private readonly peerRunning = new Map<string, number>();

  constructor(
    private readonly sqlite: SqliteStore,
    private readonly processFn: (stored: {
      id: number;
      leaseToken: string;
      envelope: DurableMessageEnvelopeV1;
    }) => Promise<void>,
    private readonly maxConcurrent: number,
  ) {}

  availableSlots(): number {
    return this.maxConcurrent - this.activeWorkers.size;
  }

  /**
   * Dispatch available messages up to capacity.
   * Does NOT await processing — returns immediately after claiming.
   */
  dispatchAvailable(accountKey: string): number {
    let dispatched = 0;
    const slots = this.availableSlots();

    for (let i = 0; i < slots; i++) {
      // Check DB pending cap
      if (this.sqlite.countPending(accountKey) > MAX_DB_PENDING) {
        console.log(`[bridge] pending queue full (${MAX_DB_PENDING}+), pausing claim`);
        break;
      }

      const claim = this.sqlite.claimNextMessage(accountKey);
      if (!claim) break;

      // Parse envelope
      const envResult = parseEnvelope(claim.payloadJson);
      if (!envResult.ok) {
        // Malformed envelope — move to dead
        this.sqlite.leaseManager.skipMessage({ id: claim.id });
        console.log(`[bridge] malformed envelope for message ${claim.id}: ${envResult.reason}`);
        continue;
      }

      const envelope = envResult.envelope;
      const abortController = new AbortController();
      const heartbeat = this.sqlite.startHeartbeat({
        id: claim.id,
        leaseToken: claim.leaseToken,
        owner: "bridge-worker",
      });

      this.activeWorkers.set(claim.id, {
        leaseToken: claim.leaseToken,
        heartbeat,
        abortController,
      });

      // Track per-peer concurrency
      const peerTag = envelope.peerRouteId;
      this.peerRunning.set(peerTag, (this.peerRunning.get(peerTag) ?? 0) + 1);

      // Fire-and-forget with abort signal
      const task = this.processFn({ id: claim.id, leaseToken: claim.leaseToken, envelope })
        .catch((err) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.sqlite.failMessage(claim.id, claim.leaseToken, errMsg, {
            errorCategory: "worker_error",
          });
        })
        .finally(() => {
          this.stopWorker(claim.id);
          const count = this.peerRunning.get(peerTag) ?? 1;
          if (count <= 1) {
            this.peerRunning.delete(peerTag);
          } else {
            this.peerRunning.set(peerTag, count - 1);
          }
        });

      dispatched++;
    }

    return dispatched;
  }

  cancelLease(id: number): void {
    const worker = this.activeWorkers.get(id);
    if (worker) {
      worker.abortController.abort("lease_lost");
      worker.heartbeat.stop();
      this.activeWorkers.delete(id);
    }
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
      this.cancelLease(id);
    }
  }

  get activeCount(): number {
    return this.activeWorkers.size;
  }

  /** Wait for all active workers to finish, with optional timeout. */
  async waitForIdle(timeoutMs?: number): Promise<void> {
    const start = Date.now();
    while (this.activeWorkers.size > 0) {
      if (timeoutMs && Date.now() - start > timeoutMs) break;
      await sleep(50);
    }
  }
}

// ---------------------------------------------------------------------------
// Main Bridge
// ---------------------------------------------------------------------------

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
  private readonly storagePolicy: StoragePolicy;
  private workerPool!: InboxWorkerPool;
  private readonly cleanups: Array<() => void> = [];
  private _accountKey = "";
  private _disposed = false;
  private _abortController?: AbortController;
  private _retentionTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly config: BridgeConfig) {
    if (config.executionMode !== "high-risk") {
      requireSecureWorkspace(config);
    }

    this.storagePolicy = new StoragePolicy({
      logLevel: config.logLevel,
      transcriptEnabled: config.transcriptEnabled,
      storeFullPrompts: config.storeFullPrompts,
      retentionDays: config.dataRetentionDays,
    });

    this.runner = config.deliveryMode === "desktop-ui"
      ? new DesktopUiRunner(config)
      : new CodexRunner(config, this.storagePolicy);
    this.fallbackRunner = config.deliveryMode === "desktop-ui" && config.cliFallbackEnabled
      ? new CodexRunner({
        ...config,
        codexSessionId: undefined,
        deliveryMode: "codex-cli",
        resumeAllSessions: false,
        resumeLast: false,
      }, this.storagePolicy)
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

    // Initialize worker pool with bounded concurrency
    const maxConc = this.config.deliveryMode === "desktop-ui"
      ? 1
      : this.config.maxParallelRuns;

    this.workerPool = new InboxWorkerPool(this.sqlite, async (params) => {
      const incomingMessage = this.envelopeToWeixinMessage(params.envelope);
      try {
        const result = await this.processMessage(incomingMessage);
        if (result === "processed") {
          this.sqlite.completeMessage(params.id, params.leaseToken);
        } else {
          this.sqlite.completeMessage(params.id, params.leaseToken);
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        this.sqlite.failMessage(params.id, params.leaseToken, errMsg);
      }
    }, maxConc);

    // Startup retention cleanup
    try {
      const cleanupResult = this.sqlite.cleanupExpiredData();
      if (cleanupResult.deletedMessages > 0 || cleanupResult.deletedFailedTasks > 0) {
        console.log(
          `[codex-weixin] cleanup: ${cleanupResult.deletedMessages} message(s), ` +
          `${cleanupResult.deletedFailedTasks} failed task(s) removed`
        );
      }
    } catch { /* non-critical */ }

    // Periodic retention scheduler
    this._retentionTimer = setInterval(() => {
      try {
        const result = this.sqlite.cleanupExpiredData();
        if (result.deletedMessages > 0 || result.deletedFailedTasks > 0) {
          console.log(
            `[codex-weixin] periodic cleanup: ${result.deletedMessages} msg(s), ` +
            `${result.deletedFailedTasks} task(s)`
          );
        }
      } catch { /* non-critical */ }
    }, 12 * 60 * 60 * 1000); // every 12 hours
    this._retentionTimer.unref();
  }

  get accountKey(): string {
    return this._accountKey;
  }

  getTaskSnapshot(): TaskSchedulerSnapshot {
    return this.scheduler.snapshot();
  }

  // -----------------------------------------------------------------------
  // Main loop — non-blocking poll with bounded dispatch
  // -----------------------------------------------------------------------

  async runForever(signal?: AbortSignal): Promise<void> {
    this._abortController = new AbortController();
    const combinedSignal = signal ?? this._abortController.signal;

    try {
      const account = this.requireAccount();
      const api = this.requireApi();
      const accountKey = this.accountKey;

      // Step 1: Recover expired leases
      const recovered = this.sqlite.recoverExpiredLeases(accountKey);
      if (recovered > 0) {
        console.log(`[codex-weixin] recovered ${recovered} stuck message(s) from SQLite inbox`);
      }

      // Step 2: Drain pending BEFORE contacting WeChat API
      this.workerPool.dispatchAvailable(accountKey);

      // Step 3: Load cursor
      const syncState = await this.state.loadSyncState(account.accountId);
      const sqliteCursor = this.sqlite.loadSyncBuf(accountKey);
      const legacyCursor = syncState.getUpdatesBuf;
      const hasDurableCursor = Boolean(sqliteCursor || legacyCursor);
      let syncBuf = sqliteCursor || legacyCursor;
      let shouldSkipBacklog = this.config.skipBacklogOnStart && !hasDurableCursor;

      // Step 4: Normal polling loop
      while (!combinedSignal.aborted && !this._disposed) {
        const response = await api.getUpdates(syncBuf, this.config.pollTimeoutMs);
        if ((response.ret ?? 0) !== 0 || (response.errcode ?? 0) !== 0) {
          if (combinedSignal.aborted) break;
          throw new Error(`Weixin getUpdates failed: ret=${response.ret ?? 0} errcode=${response.errcode ?? 0} ${response.errmsg ?? ""}`.trim());
        }

        // Build persistable batch
        const persistMessages = this.buildPersistBatch(
          account.accountId,
          response.msgs ?? [],
          shouldSkipBacklog,
        );

        // Atomically persist batch + cursor
        if (persistMessages.length > 0 || response.get_updates_buf) {
          if (persistMessages.length > 0) {
            this.sqlite.persistFetchedBatch({
              accountKey,
              nextCursor: response.get_updates_buf ?? syncBuf,
              messages: persistMessages,
            });
          }

          if (response.get_updates_buf) {
            syncBuf = response.get_updates_buf;
          }
        }

        if (shouldSkipBacklog) {
          shouldSkipBacklog = false;
          // Skip processing this cycle
          continue;
        }

        // Non-blocking dispatch: claim and fire workers without await
        this.workerPool.dispatchAvailable(accountKey);
      }
    } finally {
      await this.dispose();
    }
  }

  // -----------------------------------------------------------------------
  // Batch builder — classify messages BEFORE persistence
  // -----------------------------------------------------------------------

  private buildPersistBatch(
    accountId: string,
    messages: WeixinMessage[],
    isStartupBacklog: boolean,
  ): Array<{
    messageUid: string;
    peerId: string;
    peerHash: string;
    rawJson: string;
    text: string;
    payloadJson: string;
    payloadVersion: number | null;
    createTimeMs?: number;
    statusOverride?: "pending" | "skipped" | "rejected";
  }> {
    const result: Array<{
      messageUid: string;
      peerId: string;
      peerHash: string;
      rawJson: string;
      text: string;
      payloadJson: string;
      payloadVersion: number | null;
      createTimeMs?: number;
      statusOverride?: "pending" | "skipped" | "rejected";
    }> = [];

    for (const message of messages) {
      const peerId = message.from_user_id?.trim() ?? "";
      const text = extractWeixinText(message);
      const isBot = message.message_type === MessageType.BOT;
      const messageUid = makeMessageUid({
        accountId,
        messageId: message.message_id,
        fromUserId: message.from_user_id,
        createTimeMs: message.create_time_ms,
        sessionId: message.session_id,
        text,
        contextToken: message.context_token,
      });
      const peerHash = makePeerHash(peerId);
      const auth = peerId ? authorizePeer(peerId, this.config) : null;
      const role = auth?.role ?? "unknown";
      const oversized = text
        ? Buffer.byteLength(text, "utf8") > MAX_INBOUND_MESSAGE_BYTES
        : false;

      // Half-duck: classify BEFORE persistence
      const decision = classifyInboundMessage({
        messageType: message.message_type ?? 0,
        peerId,
        text,
        isBot,
        role,
        isStartupBacklog,
        isOversized: oversized,
        isBridgeCommand: text ? isBridgeCommandText(text.trim()) : false,
      });

      if (decision.action === "process" || decision.action === "safe-command") {
        // Build durable envelope for authorized messages
        const envelope = buildEnvelope({
          messageUid,
          messageId: message.message_id,
          messageType: message.message_type ?? 0,
          peerRouteId: peerId,
          contextToken: message.context_token,
          text: text ?? "",
          createTimeMs: message.create_time_ms,
        });

        // Store content per log level
        const payload = preparePayload(
          JSON.stringify(message),
          text ?? "",
          message.message_type ?? 0,
          isBot,
          this.config.logLevel,
        );
        const content = payloadForRole(role, payload);

        result.push({
          messageUid,
          peerId,      // used for the real route ID (stored in payload_json)
          peerHash,
          rawJson: content.rawJson,
          text: content.text,
          payloadJson: JSON.stringify(envelope),
          payloadVersion: 1,
          createTimeMs: message.create_time_ms,
          statusOverride: undefined, // stays as "pending"
        });
      } else {
        // Skip/reject: store minimal audit record, no payload
        result.push({
          messageUid,
          peerId: peerHash,  // only hash for rejected/skipped
          peerHash,
          rawJson: "",
          text: "",
          payloadJson: "",
          payloadVersion: null,
          createTimeMs: message.create_time_ms,
          statusOverride: decision.action === "reject" ? "rejected" : "skipped",
        });
      }
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // Reconstruct WeixinMessage from envelope for existing processing flow
  // -----------------------------------------------------------------------

  private envelopeToWeixinMessage(envelope: DurableMessageEnvelopeV1): WeixinMessage {
    return {
      message_id: typeof envelope.messageId === "number" ? envelope.messageId
        : envelope.messageId ? Number(envelope.messageId) : undefined,
      from_user_id: envelope.peerRouteId,
      message_type: envelope.messageType,
      item_list: envelope.text
        ? [{ type: 1, text_item: { text: envelope.text } }]
        : undefined,
      context_token: envelope.contextToken,
      create_time_ms: envelope.createTimeMs,
    };
  }

  // -----------------------------------------------------------------------
  // Message processing (unchanged from previous architecture)
  // -----------------------------------------------------------------------

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

    // Authorization check
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
        contextToken: message.context_token,
      });
      return "skipped";
    }

    if (!isBridgeCommandText(text.trim())) {
      // Plain message
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
          if (this.storagePolicy.keepFullPrompts) {
            await this.state.saveLastPrompt(sessionKey, text);
          }
          if (this.storagePolicy.keepTranscripts) {
            await this.appendInboundMirror({
              accountId: account.accountId,
              message,
              peerId,
              sessionKey,
              text,
            });
          }
          return await this.runCodexAndReply({
            accountId: account.accountId,
            contextToken: message.context_token,
            messageId: message.message_id,
            peerId,
            promptText: text,
            sessionKey,
            weixinCreateTimeMs: message.create_time_ms,
          });
        },
        { label: text.slice(0, 80) },
      );
    }

    // Bridge command handling
    const access = classifyCommand(text.trim());
    if (!canUseCommand(auth.role, access)) {
      await api.sendText({
        to: peerId,
        text: "这条管理命令需要更高的权限。",
        contextToken: message.context_token,
      });
      return "skipped";
    }

    if (this.storagePolicy.keepTranscripts) {
      await this.appendInboundMirror({
        accountId: account.accountId,
        message,
        peerId,
        sessionKey,
        text,
      });
    }

    const commandResult = await handleBridgeCommand(text, {
      config: this.config,
      sessionKey,
      state: this.state,
      taskSnapshot: this.scheduler.snapshot(),
    });

    if (commandResult.action === "switch-desktop-model" && commandResult.desktopModel) {
      const replyText = await this.switchDesktopModelForWeixin(commandResult.desktopModel);
      await api.sendText({ to: peerId, text: replyText, contextToken: message.context_token });
      if (this.storagePolicy.keepTranscripts) {
        await this.state.appendMirrorEvent({
          accountId: account.accountId,
          direction: "outbound",
          peerId,
          sessionKey,
          text: replyText,
          timestamp: new Date().toISOString(),
        });
      }
      return "processed";
    }

    if (commandResult.handled && !commandResult.promptText) {
      const replyText = commandResult.replyText ?? "";
      if (replyText) {
        await api.sendText({ to: peerId, text: replyText, contextToken: message.context_token });
        if (this.storagePolicy.keepTranscripts) {
          await this.state.appendMirrorEvent({
            accountId: account.accountId,
            direction: "outbound",
            peerId,
            sessionKey,
            text: replyText,
            timestamp: new Date().toISOString(),
          });
        }
      }
      return "processed";
    }

    const promptText = commandResult.promptText ?? text;
    if (!commandResult.promptText && this.storagePolicy.keepFullPrompts) {
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
        weixinCreateTimeMs: message.create_time_ms,
      }),
      { label: promptText.slice(0, 80) },
    );
  }

  // -----------------------------------------------------------------------
  // Codex execution and reply (unchanged)
  // -----------------------------------------------------------------------

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
          "请确认 Codex Desktop 当前空闲，并重试；如果仍失败，需要调模型选择器点击位置或识别方式。",
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
      weixinCreateTimeMs: params.message.create_time_ms,
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
      const codexResult = await this.runner.runExactPrompt(
        buildCodexPrompt(params.promptText), params.sessionKey, runOptions,
      );
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
      if (this.storagePolicy.keepTranscripts) {
        await this.state.appendMirrorEvent({
          accountId: params.accountId,
          direction: "system",
          messageId: params.messageId,
          peerId: params.peerId,
          sessionKey: params.sessionKey,
          text: failureReason,
          timestamp: new Date().toISOString(),
          weixinCreateTimeMs: params.weixinCreateTimeMs,
        });
      }
    }

    if (failureReason && this.fallbackRunner) {
      const fallbackNoticeText = "Codex Desktop 暂时没有接收成功，已自动改用 Codex CLI 继续处理，请稍等。";
      await this.sendOutboundText({
        accountId: params.accountId,
        contextToken: params.contextToken,
        peerId: params.peerId,
        sessionKey: params.sessionKey,
        text: fallbackNoticeText,
      });
      const fallbackResult = await this.runCliFallbackAfterDesktopFailure({
        accountId: params.accountId,
        desktopFailureReason: failureReason,
        messageId: params.messageId,
        peerId: params.peerId,
        promptText: params.promptText,
        runOptions: selectedSessionId ? runOptions : undefined,
        sessionKey: params.sessionKey,
        weixinCreateTimeMs: params.weixinCreateTimeMs,
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
      const redactedError = redactText(failureReason);
      await this.state.saveFailedTask({
        accountId: params.accountId,
        error: redactedError,
        id: randomUUID(),
        messageId: params.messageId,
        peerId: params.peerId,
        prompt: this.storagePolicy.keepFullPrompts ? params.promptText : `${params.promptText.slice(0, 200)}...`,
        runDirectory: failureRunDirectory,
        sessionKey: params.sessionKey,
        timestamp: new Date().toISOString(),
        weixinCreateTimeMs: params.weixinCreateTimeMs,
      });
    }

    await this.sendOutboundText({
      accountId: params.accountId,
      contextToken: params.contextToken,
      peerId: params.peerId,
      sessionKey: params.sessionKey,
      text: replyText,
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
        contextToken: params.contextToken,
      });
      if (this.storagePolicy.keepTranscripts) {
        await this.state.appendMirrorEvent({
          accountId: params.accountId,
          direction: "outbound",
          peerId: params.peerId,
          sessionKey: params.sessionKey,
          text: chunk,
          timestamp: new Date().toISOString(),
        });
      }
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
    if (this.storagePolicy.keepTranscripts) {
      await this.state.appendMirrorEvent({
        accountId: params.accountId,
        direction: "system",
        messageId: params.messageId,
        peerId: params.peerId,
        sessionKey: params.sessionKey,
        text: `Desktop UI delivery failed; trying Codex CLI fallback. Reason: ${params.desktopFailureReason}`,
        timestamp: new Date().toISOString(),
        weixinCreateTimeMs: params.weixinCreateTimeMs,
      });
    }

    try {
      const fallbackResult = await this.fallbackRunner?.runExactPrompt(
        buildCodexPrompt(params.promptText),
        params.sessionKey,
        params.runOptions,
      );
      if (fallbackResult?.ok && fallbackResult.lastMessage) {
        if (this.storagePolicy.keepTranscripts) {
          await this.state.appendMirrorEvent({
            accountId: params.accountId,
            direction: "system",
            messageId: params.messageId,
            peerId: params.peerId,
            sessionKey: params.sessionKey,
            text: "Codex CLI fallback succeeded after Desktop UI delivery failed.",
            timestamp: new Date().toISOString(),
            weixinCreateTimeMs: params.weixinCreateTimeMs,
          });
        }
        return {
          ok: true,
          replyText: fallbackResult.lastMessage,
          runDirectory: fallbackResult.runDirectory,
        };
      }
      return {
        failureReason: [
          params.desktopFailureReason,
          (fallbackResult?.stderr || fallbackResult?.stdout || "Codex CLI fallback did not return a sendable message.").trim(),
        ].filter(Boolean).join("\n"),
        ok: false,
        runDirectory: fallbackResult?.runDirectory,
      };
    } catch (error) {
      return {
        failureReason: [
          params.desktopFailureReason,
          error instanceof Error ? error.message : String(error),
        ].filter(Boolean).join("\n"),
        ok: false,
      };
    }
  }

  // -----------------------------------------------------------------------
  // Dispose — clean shutdown
  // -----------------------------------------------------------------------

  /**
   * Cleanly shut down the bridge.
   *
   * Order:
   *   1. Stop accepting new poll/claims (via disposed flag)
   *   2. Cancel all worker heartbeats
   *   3. Wait for in-flight tasks (with optional grace period)
   *   4. WAL checkpoint
   *   5. Close SQLite
   *   6. Clear timers
   *
   * Idempotent: safe to call multiple times.
   */
  async dispose(options?: { gracePeriodMs?: number }): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;

    // Stop retention timer
    if (this._retentionTimer) {
      clearInterval(this._retentionTimer);
      this._retentionTimer = undefined;
    }

    // Abort the polling loop
    this._abortController?.abort("dispose");

    // Cancel all worker leases and heartbeats
    this.workerPool?.clear();

    // Wait for in-flight tasks
    const graceMs = options?.gracePeriodMs ?? 5_000;
    await this.workerPool?.waitForIdle(graceMs);
    await timeoutPromiseSettled(Array.from(this.inFlight), 2000);

    // WAL checkpoint
    try { this.sqlite.close(); } catch { /* best effort */ }

    // Run cleanup callbacks
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isVerifiedModelSwitch(result: DesktopModelSwitchResult, model: string): boolean {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return output.includes("verified") && output.includes(model.toLowerCase());
}

function isMenuSelectedModelSwitch(result: DesktopModelSwitchResult, model: string): boolean {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return output.includes("selected codex desktop model by menu") && output.includes(model.toLowerCase());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function timeoutPromiseSettled(promises: Promise<unknown>[], ms: number): Promise<void> {
  if (promises.length === 0) return;
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, ms));
  await Promise.race([Promise.allSettled(promises), timeout]);
}
