import path from "node:path";
import net from "node:net";

import type { BridgeConfig } from "./config.js";
import { listDesktopSessions } from "./codexSession.js";
import { allowedDesktopModels, isAllowedDesktopModel, isDesktopModelCommandText, parseDesktopModelSwitch } from "./desktopModel.js";
import type { TaskSchedulerSnapshot } from "./messageScheduler.js";
import type { BridgeStateStore } from "./stateStore.js";

export interface BridgeCommandContext {
  config: BridgeConfig;
  sessionKey: string;
  state: BridgeStateStore;
  taskSnapshot?: TaskSchedulerSnapshot;
}

export interface BridgeCommandResult {
  action?: "cancel" | "switch-desktop-model";
  desktopModel?: string;
  handled: boolean;
  promptText?: string;
  replyText?: string;
  selectedSessionId?: string;
}

export async function handleBridgeCommand(
  text: string,
  context: BridgeCommandContext
): Promise<BridgeCommandResult> {
  const trimmed = text.trim();
  if (!isBridgeCommandText(trimmed)) {
    return { handled: false };
  }

  if (/^(?:\/)?(?:状态|status)$/i.test(trimmed)) {
    const selectedSessionId = await context.state.loadSelectedCodexSession(context.sessionKey);
    return {
      handled: true,
      replyText: [
        "桥：运行中",
        `模式：${context.config.deliveryMode}`,
        selectedSessionId ? `对话：已固定 ${selectedSessionId}` : "对话：跟随当前 Codex 窗口",
        context.taskSnapshot ? `任务：运行中 ${context.taskSnapshot.activeCount}/${context.taskSnapshot.maxParallel}，排队 ${context.taskSnapshot.queuedCount}` : undefined,
        `工作目录：${context.config.codexCwd}`
      ].filter((line): line is string => Boolean(line)).join("\n")
    };
  }

  if (/^(?:\/)?(?:任务|队列|tasks|queue)$/i.test(trimmed)) {
    return {
      handled: true,
      replyText: formatTaskSnapshot(context.taskSnapshot)
    };
  }

  if (/^(?:\/)?(?:诊断|doctor|diagnose)$/i.test(trimmed)) {
    return {
      handled: true,
      replyText: await formatDiagnostics(context)
    };
  }

  if (/^(?:\/)?(?:代理|agents)$/i.test(trimmed)) {
    return {
      handled: true,
      replyText: formatAgentStatus(context.config, context.taskSnapshot)
    };
  }

  if (/^(?:\/)?(?:桌面模型|desktop\s+model)$/i.test(trimmed)) {
    return {
      handled: true,
      replyText: [
        "可选 Codex Desktop 模型：",
        allowedDesktopModels.join("、"),
        "发送 /桌面模型 gpt-5.4 切换。"
      ].join("\n")
    };
  }

  if (isDesktopModelCommandText(trimmed) || /^(?:\/)?(?:桌面模型|desktop\s*model)/i.test(trimmed)) {
    const normalized = parseDesktopModelSwitch(trimmed);
    if (!normalized || !isAllowedDesktopModel(normalized)) {
      return {
        handled: true,
        replyText: `不支持的桌面模型：${trimmed}\n可选：${allowedDesktopModels.join("、")}`
      };
    }

    return {
      action: "switch-desktop-model",
      desktopModel: normalized,
      handled: true,
      replyText: `正在切换 Codex Desktop 模型：${normalized}`
    };
  }

  if (/^(?:\/)?(?:当前|current)$/i.test(trimmed)) {
    const selectedSessionId = await context.state.loadSelectedCodexSession(context.sessionKey);
    return {
      handled: true,
      replyText: selectedSessionId
        ? `当前固定对话：${selectedSessionId}\n发送 对话 当前 可改为跟随当前 Codex 窗口。`
        : "当前模式：跟随当前 Codex 窗口。发送 对话 可查看并固定对话。"
    };
  }

  const retryFailedMatch = trimmed.match(/^(?:\/)?(?:重试|retry)\s+(\d+)$/i);
  if (retryFailedMatch) {
    const index = Number.parseInt(retryFailedMatch[1] ?? "", 10);
    const task = Number.isFinite(index)
      ? await context.state.takeFailedTask(context.sessionKey, index - 1)
      : undefined;
    if (!task) {
      return {
        handled: true,
        replyText: `没有第 ${index} 条失败任务。发送 失败 查看可重试消息。`
      };
    }

    return {
      handled: true,
      promptText: task.prompt,
      replyText: `正在重试失败任务 ${index}。`
    };
  }

  if (/^(?:\/)?(?:重试|retry)$/i.test(trimmed)) {
    const prompt = await context.state.loadLastPrompt(context.sessionKey);
    if (!prompt) {
      return {
        handled: true,
        replyText: "没有可重试的上一条普通消息。"
      };
    }

    return {
      handled: true,
      promptText: prompt,
      replyText: "正在重试上一条消息。"
    };
  }

  if (/^(?:\/)?(?:取消|cancel)$/i.test(trimmed)) {
    return {
      action: "cancel",
      handled: true,
      replyText: "已收到取消请求。当前版本会阻止这条控制词进入 Codex；实时打断正在生成的回复还需要后台轮询改造。"
    };
  }

  if (/^(?:\/)?(?:失败|failed|failures)$/i.test(trimmed)) {
    return {
      handled: true,
      replyText: formatFailedTasks(await context.state.listFailedTasks(context.sessionKey))
    };
  }

  if (/^(?:\/)?(?:清空失败|clear\s+failures|clear\s+failed)$/i.test(trimmed)) {
    const count = await context.state.clearFailedTasks(context.sessionKey);
    return {
      handled: true,
      replyText: count > 0
        ? `已清空当前会话的失败任务：${count} 条。`
        : "当前会话没有可清空的失败任务。"
    };
  }

  if (/^(?:\/)?(?:归档失败|archive\s+failures|archive\s+failed)$/i.test(trimmed)) {
    const count = await context.state.archiveFailedTasks(context.sessionKey);
    return {
      handled: true,
      replyText: count > 0
        ? `已归档当前会话的失败任务：${count} 条。`
        : "当前会话没有可归档的失败任务。"
    };
  }

  const discardFailedMatch = trimmed.match(/^(?:\/)?(?:丢弃|discard)\s+(\d+)$/i);
  if (discardFailedMatch) {
    const index = Number.parseInt(discardFailedMatch[1] ?? "", 10);
    const task = Number.isFinite(index)
      ? await context.state.discardFailedTask(context.sessionKey, index - 1)
      : undefined;
    return {
      handled: true,
      replyText: task
        ? `已丢弃失败任务 ${index}：${previewText(task.prompt)}`
        : `没有第 ${index} 条失败任务。发送 失败 查看可丢弃消息。`
    };
  }

  if (/^(?:\/)?(?:帮助|help)$/i.test(trimmed)) {
    return {
      handled: true,
      replyText: "可用命令：状态、诊断、当前、对话、对话 1、对话 当前、记录、失败、重试 1、丢弃 1、清空失败、clear failures、归档失败、archive failures、任务、代理、桌面模型、取消。"
    };
  }

  const recordsMatch = trimmed.match(/^(?:\/)?(?:记录|聊天记录|微信记录|history|records)(?:\s+(.+))?$/i);
  if (recordsMatch) {
    const recordsQuery = parseRecordsQuery(recordsMatch[1] ?? "");
    const events = await context.state.listMirrorEvents(context.sessionKey, recordsQuery);
    return {
      handled: true,
      replyText: formatMirrorEvents(events, recordsQuery.query)
    };
  }

  const sessions = listDesktopSessions({
    codexHome: context.config.codexHome,
    limit: 8
  });

  if (/^(?:\/)?(?:对话|会话)$/i.test(trimmed) || /^\/codex\s+sessions$/i.test(trimmed)) {
    return {
      handled: true,
      replyText: formatConversationList(sessions, await context.state.loadSelectedCodexSession(context.sessionKey))
    };
  }

  const followCurrentWithPromptMatch = trimmed.match(/^(?:\/)?(?:对话|会话)\s*(?:当前|current)\s+([\s\S]+)$/i);
  if (followCurrentWithPromptMatch) {
    await context.state.clearSelectedCodexSession(context.sessionKey);
    return {
      handled: true,
      promptText: followCurrentWithPromptMatch[1]?.trim()
    };
  }

  if (/^(?:\/)?(?:对话|会话)\s+(?:当前|current)$/i.test(trimmed)) {
    await context.state.clearSelectedCodexSession(context.sessionKey);
    return {
      handled: true,
      replyText: "已切换为跟随当前 Codex 窗口。你在 Codex Desktop 里打开哪个对话，微信就会发到哪个对话。",
      selectedSessionId: undefined
    };
  }

  const selectMatch = trimmed.match(/^(?:\/)?(?:对话|会话)\s+(\d+)$/i);
  if (selectMatch) {
    const index = Number.parseInt(selectMatch[1] ?? "", 10);
    const session = Number.isFinite(index) ? sessions[index - 1] : undefined;
    if (!session) {
      return {
        handled: true,
        replyText: `没有第 ${index} 个对话。发送 /对话 查看可选对话。`
      };
    }

    await context.state.saveSelectedCodexSession(context.sessionKey, session.id);
    return {
      handled: true,
      replyText: `已选择：${formatSessionLine(index, session)}\n请先在 Codex Desktop 打开这个对话窗口，再从微信发送消息；桥会校验消息是否落到这个对话。`,
      selectedSessionId: session.id
    };
  }

  return {
    handled: true,
    replyText: "可用命令：/对话 查看最近对话；/对话 1 选择；/对话 当前 跟随当前 Codex 窗口。"
  };
}

function isConversationCommand(text: string): boolean {
  return /^(?:\/)?(?:对话|会话)(?:\s|当前|current|$)/i.test(text) ||
    /^\/codex\s+sessions$/i.test(text);
}

export function isBridgeCommandText(text: string): boolean {
  return isDesktopModelCommandText(text) ||
    isConversationCommand(text) ||
    /^(?:\/)?(?:状态|status|诊断|doctor|diagnose|当前|current|任务|队列|tasks|queue|代理|agents|桌面模型|desktop\s+model|记录|聊天记录|微信记录|history|records|失败|failed|failures|清空失败|clear\s+failures|clear\s+failed|归档失败|archive\s+failures|archive\s+failed|重试|retry|丢弃|discard|取消|cancel|帮助|help)(?:\s|$)/i.test(text);
}

function parseRecordsQuery(raw: string): { limit: number; query?: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { limit: 8 };
  }

  const numberOnly = Number.parseInt(trimmed, 10);
  if (/^\d+$/.test(trimmed) && Number.isFinite(numberOnly)) {
    return { limit: clamp(numberOnly, 1, 50) };
  }

  const match = trimmed.match(/^(\d+)\s+(.+)$/);
  if (match) {
    return {
      limit: clamp(Number.parseInt(match[1] ?? "", 10), 1, 50),
      query: match[2]?.trim()
    };
  }

  return { limit: 20, query: trimmed };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatMirrorEvents(events: Awaited<ReturnType<BridgeStateStore["listMirrorEvents"]>>, query?: string): string {
  if (events.length === 0) {
    return [
      query
        ? `微信桥记录：没有找到包含「${query}」的本地镜像记录。`
        : "微信桥记录：当前微信会话还没有本地镜像记录。",
      "说明：这里查的是桥自己的 transcript；Codex 项目历史只显示成功写入 Codex Desktop session 的对话。"
    ].join("\n");
  }

  return [
    query
      ? `微信桥最近记录（包含「${query}」，本地镜像，不等于 Codex 项目历史）：`
      : "微信桥最近记录（本地镜像，不等于 Codex 项目历史）：",
    ...events.map((event, index) => `${index + 1}. ${formatTimestamp(event.timestamp)} ${formatDirection(event.direction)}：${previewText(event.text)}`),
    "说明：如果这里有记录但项目里没有，说明这条消息没有成功写入 Codex Desktop session。"
  ].join("\n");
}

function formatFailedTasks(tasks: Awaited<ReturnType<BridgeStateStore["listFailedTasks"]>>): string {
  if (tasks.length === 0) {
    return "失败任务：当前没有可重试的失败消息。";
  }

  return [
    "失败任务：",
    ...tasks.map((task, index) => `${index + 1}. ${formatTimestamp(task.timestamp)}：${previewText(task.prompt)}\n原因：${previewText(task.error)}`),
    "发送 重试 1 重新发送；发送 丢弃 1 移除。"
  ].join("\n");
}

async function formatDiagnostics(context: BridgeCommandContext): Promise<string> {
  const selectedSessionId = await context.state.loadSelectedCodexSession(context.sessionKey);
  const events = await context.state.listMirrorEvents(context.sessionKey, { limit: 20 });
  const lastSystem = [...events].reverse().find((event) => event.direction === "system");
  const failures = await context.state.listFailedTasks(context.sessionKey);
  const recentRuns = await context.state.listRecentRuns(1);
  const port18789 = await isLocalPortOpen(18789);
  const port8787 = await isLocalPortOpen(8787);
  const latestRun = recentRuns[0];

  return [
    "微信桥诊断：",
    "桥：运行中",
    `模式：${context.config.deliveryMode}`,
    selectedSessionId ? `对话：已固定 ${selectedSessionId}` : "对话：跟随当前 Codex 窗口",
    context.taskSnapshot ? `任务：运行中 ${context.taskSnapshot.activeCount}/${context.taskSnapshot.maxParallel}，排队 ${context.taskSnapshot.queuedCount}` : "任务：暂无快照",
    `失败任务：${failures.length}`,
    `端口 18789：${port18789 ? "有监听" : "未监听"}`,
    `端口 8787：${port8787 ? "有监听" : "未监听"}`,
    latestRun ? `最近运行：${latestRun.name}` : "最近运行：无",
    latestRun?.stderrPreview ? `最近错误：${latestRun.stderrPreview}` : lastSystem ? `最近系统记录：${previewText(lastSystem.text)}` : "最近错误：无",
    `工作目录：${context.config.codexCwd}`
  ].join("\n");
}

function formatTimestamp(timestamp: string): string {
  return timestamp.replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function formatDirection(direction: "inbound" | "outbound" | "system"): string {
  if (direction === "inbound") {
    return "入站";
  }
  if (direction === "outbound") {
    return "出站";
  }
  return "系统";
}

function previewText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 80 ? `${compact.slice(0, 80)}...` : compact;
}

function formatTaskSnapshot(snapshot: TaskSchedulerSnapshot | undefined): string {
  if (!snapshot) {
    return "任务队列：暂无运行状态。";
  }

  const lines = [
    `任务队列：运行中：${snapshot.activeCount}/${snapshot.maxParallel}，排队：${snapshot.queuedCount}`
  ];
  const activeSessions = snapshot.sessions.filter((session) => session.active || session.queuedCount > 0);
  if (activeSessions.length === 0) {
    lines.push("当前没有排队中的微信消息。");
  } else {
    lines.push(...activeSessions.map((session, index) =>
      `${index + 1}. ${session.sessionKey}：${session.active ? "运行中" : "等待"}，排队 ${session.queuedCount}`
    ));
  }

  return lines.join("\n");
}

function formatAgentStatus(config: BridgeConfig, snapshot: TaskSchedulerSnapshot | undefined): string {
  const maxParallel = snapshot?.maxParallel ?? config.maxParallelRuns;
  const lines = [
    "多代理模式：已启用",
    config.deliveryMode === "desktop-ui"
      ? "执行方式：desktop-ui 单通道，避免多个代理同时抢同一个 Codex 窗口。"
      : "执行方式：codex-cli 多通道，不同微信会话可以并行。",
    `最大并行：${maxParallel}`,
    "同一微信会话：严格按发送顺序处理。"
  ];

  if (snapshot) {
    lines.push(`当前任务：运行中 ${snapshot.activeCount}/${snapshot.maxParallel}，排队 ${snapshot.queuedCount}`);
  }

  return lines.join("\n");
}

function formatConversationList(sessions: ReturnType<typeof listDesktopSessions>, selectedSessionId?: string): string {
  if (sessions.length === 0) {
    return "没有找到 Codex Desktop 对话。";
  }

  return [
    "最近 Codex Desktop 对话：",
    ...sessions.map((session, index) => formatSessionLine(index + 1, session, selectedSessionId)),
    "发送 /对话 1 选择；发送 /对话 当前 跟随当前 Codex 窗口。"
  ].join("\n");
}

function formatSessionLine(index: number, session: ReturnType<typeof listDesktopSessions>[number], selectedSessionId?: string): string {
  const title = session.title || session.id;
  const cwdName = path.basename(session.cwd) || session.cwd;
  const shortId = session.id.slice(0, 8);
  const selected = selectedSessionId === session.id ? "，当前固定" : "";
  return `${index}. ${title} [${cwdName}, ${shortId}${selected}]`;
}

function isLocalPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(250);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}
