import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

import type { BridgeConfig } from "./config.js";
import { buildConfigDiagnostics, type ConfigDiagnosticCheck } from "./configDiagnostics.js";
import { buildCodexPrompt } from "./codexPrompt.js";
import { CodexRunner } from "./codexRunner.js";
import { detectCodexDesktopInputTarget } from "./desktopInput.js";
import { DesktopUiRunner } from "./desktopUiRunner.js";
import {
  allowedDesktopModels,
  isAllowedDesktopModel,
  normalizeDesktopModelName,
  switchCodexDesktopModel,
  type DesktopModelSwitchResult
} from "./desktopModel.js";
import type { TaskSchedulerSnapshot } from "./messageScheduler.js";
import { BridgeStateStore } from "./stateStore.js";
import type { BridgeRunResult, CodexRunOptions } from "./types.js";

export interface ConsoleServerHandle {
  close(): Promise<void>;
  url: string;
}

export interface ConsoleServerOptions {
  getTaskSnapshot?: () => TaskSchedulerSnapshot | undefined;
}

type ConsoleRunner = {
  runExactPrompt(prompt: string, sessionKey: string, options?: CodexRunOptions): Promise<BridgeRunResult>;
};

interface ActionRequest {
  id?: string;
  model?: string;
  sessionKey?: string;
}

export type ConsoleModelSwitchStatus = "failed" | "selected" | "unconfirmed" | "verified";

export interface ConsoleAgentStatus {
  activeCount: number;
  deliveryMode: BridgeConfig["deliveryMode"];
  description: string;
  maxParallel: number;
  mode: "desktop-single-lane" | "multi-agent" | "single-agent";
  queuedCount: number;
  sessions: TaskSchedulerSnapshot["sessions"];
}

export function buildConsoleAgentStatus(
  config: Pick<BridgeConfig, "deliveryMode" | "maxParallelRuns">,
  snapshot?: TaskSchedulerSnapshot
): ConsoleAgentStatus {
  const maxParallel = snapshot?.maxParallel ?? (config.deliveryMode === "desktop-ui" ? 1 : config.maxParallelRuns);
  const mode = config.deliveryMode === "desktop-ui"
    ? "desktop-single-lane"
    : maxParallel > 1
      ? "multi-agent"
      : "single-agent";
  const description = config.deliveryMode === "desktop-ui"
    ? "Desktop UI uses one single owner lane so agents do not compete for the same Codex window."
    : maxParallel > 1
      ? "Codex CLI can process different Weixin sessions in parallel while keeping each session ordered."
      : "Codex CLI is currently limited to one worker lane.";

  return {
    activeCount: snapshot?.activeCount ?? 0,
    deliveryMode: config.deliveryMode,
    description,
    maxParallel,
    mode,
    queuedCount: snapshot?.queuedCount ?? 0,
    sessions: snapshot?.sessions ?? []
  };
}

export function startConsoleServer(config: BridgeConfig, options: ConsoleServerOptions = {}): Promise<ConsoleServerHandle> {
  const state = new BridgeStateStore(config);
  const runner: ConsoleRunner = config.deliveryMode === "desktop-ui"
    ? new DesktopUiRunner(config)
    : new CodexRunner(config);
  const startedAt = new Date().toISOString();

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${config.consolePort}`);
      if (request.method === "GET" && url.pathname === "/") {
        send(response, 200, "text/html; charset=utf-8", renderConsoleHtml());
        return;
      }

      if (request.method === "GET" && url.pathname === "/favicon.ico") {
        response.writeHead(204, { "Cache-Control": "max-age=86400" });
        response.end();
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/status") {
        const taskSnapshot = options.getTaskSnapshot?.();
        const configChecks = buildConfigDiagnostics(config);
        const configRiskCount = configChecks.filter((check) => !check.ok).length;
        const body = {
          agentStatus: buildConsoleAgentStatus(config, taskSnapshot),
          allowedDesktopModels,
          codexCwd: config.codexCwd,
          configChecks,
          configRiskCount,
          deliveryMode: config.deliveryMode,
          failedTasks: await state.listAllFailedTasks(20),
          logRoot: config.logRoot,
          maxParallelRuns: config.maxParallelRuns,
          recentRuns: await state.listRecentRuns(8),
          startedAt,
          taskSnapshot,
          transcripts: await state.listTranscriptSummaries(20)
        };
        send(response, 200, "application/json; charset=utf-8", JSON.stringify(body));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/diagnostics") {
        sendJson(response, 200, await buildDiagnostics(config, state, startedAt));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/desktop-input/detect") {
        const result = await runDesktopInputDetection(config);
        sendJson(response, result.ok ? 200 : 500, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/desktop-model") {
        const body = await readJsonRequest<ActionRequest>(request);
        const model = normalizeDesktopModelName(String(body.model ?? ""));
        if (!model || !isAllowedDesktopModel(model)) {
          sendJson(response, 400, {
            ok: false,
            message: `Unsupported Codex Desktop model: ${body.model ?? ""}`,
            allowedDesktopModels
          });
          return;
        }

        const result = await switchCodexDesktopModel(config.desktopModelScriptPath, model);
        const status = classifyDesktopModelSwitchResult(result, model);
        sendJson(response, status === "failed" ? 500 : 200, {
          ok: status !== "failed",
          message: formatModelSwitchMessage(status, model, result),
          model,
          status,
          stderr: result.stderr,
          stdout: result.stdout
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/failed/discard") {
        const body = await readJsonRequest<ActionRequest>(request);
        if (!body.sessionKey || !body.id) {
          sendJson(response, 400, { ok: false, message: "sessionKey and id are required." });
          return;
        }

        const task = await state.discardFailedTaskById(body.sessionKey, body.id);
        sendJson(response, task ? 200 : 404, {
          ok: Boolean(task),
          message: task ? "Failed task discarded." : "Failed task was not found.",
          task
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/failed/clear") {
        const body = await readJsonRequest<Pick<ActionRequest, "sessionKey">>(request);
        if (!body.sessionKey) {
          sendJson(response, 400, { ok: false, message: "sessionKey is required." });
          return;
        }

        const count = await state.clearFailedTasks(body.sessionKey);
        sendJson(response, 200, {
          count,
          ok: true,
          message: count > 0
            ? `Cleared ${count} failed task(s).`
            : "No failed tasks to clear."
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/failed/archive") {
        const body = await readJsonRequest<Pick<ActionRequest, "sessionKey">>(request);
        if (!body.sessionKey) {
          sendJson(response, 400, { ok: false, message: "sessionKey is required." });
          return;
        }

        const count = await state.archiveFailedTasks(body.sessionKey);
        sendJson(response, 200, {
          count,
          ok: true,
          message: count > 0
            ? `Archived ${count} failed task(s).`
            : "No failed tasks to archive."
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/failed/retry") {
        const body = await readJsonRequest<ActionRequest>(request);
        if (!body.sessionKey || !body.id) {
          sendJson(response, 400, { ok: false, message: "sessionKey and id are required." });
          return;
        }

        const result = await retryFailedTask(config, state, runner, body.sessionKey, body.id);
        sendJson(response, result.ok ? 200 : 500, result);
        return;
      }

      send(response, 404, "text/plain; charset=utf-8", "Not found");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send(response, 500, "text/plain; charset=utf-8", message);
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.consolePort, "127.0.0.1", () => {
      server.off("error", reject);
      resolve({
        close: () => new Promise<void>((closeResolve, closeReject) => {
          server.close((error) => error ? closeReject(error) : closeResolve());
        }),
        url: `http://127.0.0.1:${config.consolePort}/`
      });
    });
  });
}

function send(response: http.ServerResponse, statusCode: number, contentType: string, body: string): void {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": contentType
  });
  response.end(body);
}

function sendJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
  send(response, statusCode, "application/json; charset=utf-8", JSON.stringify(body));
}

async function readJsonRequest<T>(request: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 128 * 1024) {
      throw new Error("Request body is too large.");
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) as T : {} as T;
}

export function classifyDesktopModelSwitchResult(
  result: DesktopModelSwitchResult,
  model: string
): ConsoleModelSwitchStatus {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (result.exitCode !== 0) {
    return "failed";
  }
  if (output.includes("verified") && output.includes(model.toLowerCase())) {
    return "verified";
  }
  if (output.includes("selected codex desktop model by menu") && output.includes(model.toLowerCase())) {
    return "selected";
  }
  return "unconfirmed";
}

function formatModelSwitchMessage(
  status: ConsoleModelSwitchStatus,
  model: string,
  result: DesktopModelSwitchResult
): string {
  if (status === "verified") {
    return `Verified Codex Desktop model: ${model}`;
  }
  if (status === "selected") {
    return `Selected Codex Desktop model by menu: ${model}`;
  }
  if (status === "unconfirmed") {
    return `Clicked Codex Desktop model menu, but could not verify: ${model}`;
  }

  const reason = (result.stderr || result.stdout).trim();
  return reason || `Codex Desktop model switch failed with exit code ${result.exitCode ?? "unknown"}.`;
}

async function runDesktopInputDetection(config: BridgeConfig): Promise<{
  exitCode: number | null;
  message: string;
  ok: boolean;
  promptPath: string;
  stderr: string;
  stdout: string;
}> {
  const probeDir = path.join(config.logRoot, "tmp");
  await mkdir(probeDir, { recursive: true });
  const promptPath = path.join(probeDir, "desktop-input-detect.txt");
  await writeFile(promptPath, "desktop input detection probe\n", "utf8");

  const result = await detectCodexDesktopInputTarget(config.desktopInputScriptPath, promptPath);
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  return {
    ...result,
    message: output || `Desktop input detection exited with code ${result.exitCode ?? "unknown"}.`,
    ok: result.exitCode === 0,
    promptPath
  };
}

async function retryFailedTask(
  config: BridgeConfig,
  state: BridgeStateStore,
  runner: ConsoleRunner,
  sessionKey: string,
  id: string
): Promise<{
  lastMessage?: string;
  message: string;
  ok: boolean;
  runDirectory?: string;
}> {
  const task = (await state.listFailedTasks(sessionKey)).find((item) => item.id === id);
  if (!task) {
    return { ok: false, message: "Failed task was not found." };
  }

  const selectedSessionId = await state.loadSelectedCodexSession(sessionKey);
  const runOptions = selectedSessionId
    ? { codexSessionId: selectedSessionId, strictSession: true }
    : undefined;

  let result: BridgeRunResult | undefined;
  let usedFallback = false;
  let desktopFailureReason = "";
  try {
    result = await runner.runExactPrompt(buildCodexPrompt(task.prompt), sessionKey, runOptions);
    if (!result.ok || !result.lastMessage) {
      desktopFailureReason = (result.stderr || result.stdout || "Codex did not return a sendable message.").trim();
    }
  } catch (error) {
    desktopFailureReason = error instanceof Error ? error.message : String(error);
  }

  if ((!result?.ok || !result.lastMessage) && config.deliveryMode === "desktop-ui" && config.cliFallbackEnabled) {
    const fallbackRunner = new CodexRunner({
      ...config,
      codexSessionId: undefined,
      deliveryMode: "codex-cli",
      resumeAllSessions: false,
      resumeLast: false
    });
    try {
      result = await fallbackRunner.runExactPrompt(
        buildCodexPrompt(task.prompt),
        sessionKey,
        selectedSessionId ? runOptions : undefined
      );
      usedFallback = true;
    } catch (error) {
      const fallbackReason = error instanceof Error ? error.message : String(error);
      return {
        message: [desktopFailureReason, fallbackReason].filter(Boolean).join("\n"),
        ok: false
      };
    }
  }

  if (!result?.ok || !result.lastMessage) {
    return {
      ok: false,
      message: [
        desktopFailureReason,
        (result?.stderr || result?.stdout || "Codex did not return a sendable message.").trim()
      ].filter(Boolean).join("\n"),
      runDirectory: result?.runDirectory
    };
  }

  await state.takeFailedTaskById(sessionKey, id);
  await state.appendMirrorEvent({
    accountId: task.accountId,
    direction: "system",
    messageId: task.messageId,
    peerId: task.peerId,
    sessionKey,
    text: `Console retried failed task ${id}${usedFallback ? " via Codex CLI fallback" : ""}. Last Codex message: ${result.lastMessage}`,
    timestamp: new Date().toISOString(),
    weixinCreateTimeMs: task.weixinCreateTimeMs
  });
  return {
    lastMessage: result.lastMessage,
    message: usedFallback
      ? "Failed task retried with Codex CLI fallback."
      : "Failed task retried in Codex Desktop.",
    ok: true,
    runDirectory: result.runDirectory
  };
}

async function buildDiagnostics(config: BridgeConfig, state: BridgeStateStore, startedAt: string): Promise<{
  checks: Array<ConfigDiagnosticCheck | { detail: string; label: string; ok: boolean; severity?: "error" | "ok" | "warn" }>;
  codexCwd: string;
  deliveryMode: string;
  failedTaskCount: number;
  latestRun?: { name: string; stderrPreview: string; stdoutPreview: string };
  logRoot: string;
  startedAt: string;
}> {
  const [failedTasks, recentRuns, port18789, port8787, codexWindow] = await Promise.all([
    state.listAllFailedTasks(100),
    state.listRecentRuns(1),
    isLocalPortOpen(18789),
    isLocalPortOpen(8787),
    getCodexDesktopWindowStatus()
  ]);
  const latestRun = recentRuns[0];
  const configChecks = buildConfigDiagnostics(config);

  return {
    checks: [
      { detail: `Console started at ${startedAt}`, label: "Console server", ok: true },
      { detail: port18789 ? "A process is listening on 18789." : "No listener on 18789.", label: "OpenClaw port 18789", ok: !port18789 },
      { detail: port8787 ? "A process is listening on 8787." : "No listener on 8787.", label: "Old bridge port 8787", ok: !port8787 },
      { detail: codexWindow.detail, label: "Codex Desktop window", ok: codexWindow.ok },
      { detail: `${failedTasks.length} failed task(s).`, label: "Failed tasks", ok: failedTasks.length === 0 },
      ...configChecks
    ],
    codexCwd: config.codexCwd,
    deliveryMode: config.deliveryMode,
    failedTaskCount: failedTasks.length,
    latestRun: latestRun
      ? {
        name: latestRun.name,
        stderrPreview: latestRun.stderrPreview,
        stdoutPreview: latestRun.stdoutPreview
      }
      : undefined,
    logRoot: config.logRoot,
    startedAt
  };
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

async function getCodexDesktopWindowStatus(): Promise<{ detail: string; ok: boolean }> {
  const script = [
    "$p = Get-Process -Name Codex -ErrorAction SilentlyContinue |",
    "Where-Object { $_.MainWindowHandle -ne 0 } |",
    "Sort-Object StartTime -Descending | Select-Object -First 1;",
    "if ($p) {",
    "  [pscustomobject]@{ ok = $true; detail = \"PID $($p.Id), HWND $($p.MainWindowHandle)\" } | ConvertTo-Json -Compress",
    "} else {",
    "  [pscustomobject]@{ ok = $false; detail = \"Codex Desktop window was not found.\" } | ConvertTo-Json -Compress",
    "}"
  ].join(" ");

  return await new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => resolve({ ok: false, detail: error.message }));
    child.on("close", () => {
      const raw = Buffer.concat(stdout).toString("utf8").trim();
      try {
        const parsed = JSON.parse(raw) as { detail?: unknown; ok?: unknown };
        resolve({
          detail: typeof parsed.detail === "string" ? parsed.detail : raw,
          ok: parsed.ok === true
        });
      } catch {
        const errorText = Buffer.concat(stderr).toString("utf8").trim();
        resolve({ ok: false, detail: errorText || raw || "Could not inspect Codex Desktop window." });
      }
    });
  });
}

export function renderConsoleHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Codex 微信桥控制台</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --panel-2: #fbfcfd;
      --text: #17202a;
      --muted: #667085;
      --border: #dde3ea;
      --accent: #1f7a5c;
      --warning: #b54708;
      --danger: #b42318;
      --shadow: 0 10px 28px rgba(16, 24, 40, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 "Segoe UI", Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
    }
    .shell { display: grid; grid-template-columns: 220px 1fr; min-height: 100vh; }
    nav {
      background: #111827;
      color: #e5e7eb;
      padding: 22px 16px;
    }
    nav h1 { margin: 0 0 24px; font-size: 17px; line-height: 1.2; }
    nav a {
      display: block;
      color: #cbd5e1;
      text-decoration: none;
      padding: 9px 10px;
      border-radius: 6px;
      margin-bottom: 4px;
    }
    nav a:hover { background: rgba(255,255,255,0.08); color: #fff; }
    main { padding: 24px; }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 18px;
    }
    .topbar h2 { margin: 0; font-size: 22px; }
    .actions { display: flex; align-items: center; gap: 10px; }
    .language-control {
      display: flex;
      align-items: center;
      gap: 7px;
      color: var(--muted);
      font-size: 12px;
    }
    select, button {
      border: 1px solid #cbd5e1;
      background: #fff;
      color: var(--text);
      border-radius: 6px;
      padding: 8px 12px;
      font: inherit;
    }
    select { padding-right: 28px; }
    button { cursor: pointer; }
    button:hover { border-color: #94a3b8; }
    .grid { display: grid; gap: 14px; }
    .cards { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .card, .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }
    .card { padding: 14px; min-height: 92px; }
    .label { color: var(--muted); font-size: 12px; margin-bottom: 8px; }
    .value { font-size: 18px; font-weight: 650; word-break: break-word; }
    .ok { color: var(--accent); }
    .warn { color: var(--warning); }
    .danger { color: var(--danger); }
    .panel { margin-top: 14px; overflow: hidden; }
    .panel > h3, .panel-header {
      margin: 0;
      padding: 12px 14px;
      background: var(--panel-2);
      border-bottom: 1px solid var(--border);
    }
    .panel h3 {
      margin: 0;
      font-size: 14px;
    }
    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .count-pill {
      border: 1px solid #cbd5e1;
      border-radius: 999px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1;
      padding: 5px 8px;
      white-space: nowrap;
    }
    .table-scroll { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      text-align: left;
      vertical-align: top;
    }
    th { color: var(--muted); font-size: 12px; font-weight: 600; background: #fbfcfd; }
    tr:last-child td { border-bottom: 0; }
    code {
      font-family: "Cascadia Mono", Consolas, monospace;
      font-size: 12px;
      color: #344054;
      word-break: break-word;
    }
    .empty { padding: 16px; color: var(--muted); }
    .control-grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      padding: 14px;
    }
    .control-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .control-row select { min-width: 180px; }
    .status-box {
      border-top: 1px solid var(--border);
      padding: 12px 14px;
      color: var(--muted);
      min-height: 42px;
      white-space: pre-wrap;
    }
    .row-actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .failure-list {
      display: grid;
      gap: 10px;
      padding: 12px;
    }
    .failure-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      background: #fff;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
    }
    .failure-meta {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 8px;
    }
    .session-chip {
      max-width: 100%;
      border: 1px solid #d7dee8;
      border-radius: 999px;
      color: #475467;
      background: #f8fafc;
      font-family: "Cascadia Mono", Consolas, monospace;
      font-size: 11px;
      line-height: 1;
      padding: 5px 8px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .failure-label {
      display: block;
      color: var(--muted);
      font-size: 11px;
      font-weight: 650;
      margin: 0 0 4px;
      text-transform: uppercase;
    }
    .failure-prompt { margin-bottom: 8px; }
    .failure-prompt code,
    .failure-details code {
      display: block;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      max-height: 110px;
      overflow: auto;
      padding: 8px;
    }
    .failure-details summary {
      color: var(--muted);
      cursor: pointer;
      font-size: 12px;
      margin: 6px 0;
    }
    .failure-details .failure-label { margin-top: 8px; }
    .failure-actions {
      align-content: flex-start;
      justify-content: flex-end;
      min-width: 200px;
    }
    button.small { padding: 5px 8px; font-size: 12px; }
    button.danger { color: var(--danger); }
    button:disabled { cursor: progress; opacity: 0.65; }
    @media (max-width: 900px) {
      .shell { grid-template-columns: 1fr; }
      nav { position: static; }
      .cards { grid-template-columns: 1fr 1fr; }
      .control-grid { grid-template-columns: 1fr; }
      .failure-item { grid-template-columns: 1fr; }
      .failure-actions { justify-content: flex-start; min-width: 0; }
    }
    @media (max-width: 560px) {
      main { padding: 16px; }
      .cards { grid-template-columns: 1fr; }
      th, td { padding: 9px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <nav>
      <h1>Codex 微信桥</h1>
      <a href="#controls" data-i18n="navControls">控制</a>
      <a href="#overview" data-i18n="navOverview">概览</a>
      <a href="#failures" data-i18n="navFailures">失败任务</a>
      <a href="#records" data-i18n="navRecords">记录</a>
      <a href="#runs" data-i18n="navRuns">运行</a>
    </nav>
    <main>
      <div class="topbar">
        <h2 data-i18n="title">桥控制台</h2>
        <div class="actions">
          <label class="language-control" for="language">
            <span data-i18n="language">语言</span>
            <select id="language" aria-label="语言">
              <option value="en">English</option>
              <option value="zh-CN">简体中文</option>
            </select>
          </label>
          <button id="refresh" data-i18n="refresh">刷新</button>
        </div>
      </div>
      <section id="controls" class="panel">
        <h3 data-i18n="controls">控制</h3>
        <div class="control-grid">
          <div>
            <div class="label" data-i18n="desktopModel">桌面模型</div>
            <div class="control-row">
              <select id="model"></select>
              <button id="switch-model" data-i18n="switchModel">切换模型</button>
            </div>
          </div>
          <div>
            <div class="label" data-i18n="diagnostics">诊断</div>
            <div class="control-row">
              <button id="run-diagnostics" data-i18n="runDiagnostics">运行诊断</button>
              <button id="detect-composer" data-i18n="detectComposer">检测输入框</button>
            </div>
          </div>
        </div>
        <div id="action-status" class="status-box"></div>
      </section>
      <section id="overview" class="grid cards"></section>
      <section id="failures" class="panel"><h3 data-i18n="failedTasks">失败任务</h3><div class="empty" data-i18n="loading">加载中...</div></section>
      <section id="records" class="panel"><h3 data-i18n="transcriptMirrors">记录镜像</h3><div class="empty" data-i18n="loading">加载中...</div></section>
      <section id="runs" class="panel"><h3 data-i18n="recentRuns">最近运行</h3><div class="empty" data-i18n="loading">加载中...</div></section>
    </main>
  </div>
  <script>
    const $ = (id) => document.getElementById(id);
    const I18N = {
      en: {
        actions: "Actions",
        agentMode: "Agent Mode",
        agentQueue: "Agent Queue",
        archiveFailures: "Archive Session",
        bridge: "Bridge",
        clearFailures: "Clear Session",
        configHealth: "Config Health",
        configRisks: "Config Risks",
        controls: "Controls",
        detectComposer: "Detect Input",
        desktopModel: "Desktop Model",
        details: "Details",
        diagnostics: "Diagnostics",
        discard: "Discard",
        error: "Error",
        failed: "Failed",
        failedTasks: "Failed Tasks",
        followCurrent: "Follow current",
        items: "items",
        language: "Language",
        last: "Last",
        lines: "Lines",
        loading: "Loading...",
        mode: "Mode",
        maxParallel: "Max Parallel",
        navControls: "Controls",
        navFailures: "Failures",
        navOverview: "Overview",
        navRecords: "Records",
        navRuns: "Runs",
        noData: "No data",
        prompt: "Prompt",
        ready: "Ready.",
        recentRuns: "Recent Runs",
        records: "Records",
        refresh: "Refresh",
        retry: "Retry",
        running: "Running",
        run: "Run",
        runDiagnostics: "Run Diagnostics",
        selectedConversation: "Selected Conversation",
        session: "Session",
        sessionId: "Session ID",
        stateRoot: "State Root",
        stderr: "Stderr",
        stdout: "Stdout",
        switchModel: "Switch Model",
        time: "Time",
        title: "Bridge Console",
        transcriptMirrors: "Transcript Mirrors"
      },
      "zh-CN": {
        actions: "操作",
        agentMode: "代理模式",
        agentQueue: "代理队列",
        archiveFailures: "归档会话",
        bridge: "桥状态",
        clearFailures: "清空会话",
        configHealth: "配置健康",
        configRisks: "配置风险",
        controls: "控制",
        detectComposer: "检测输入框",
        desktopModel: "桌面模型",
        details: "详情",
        diagnostics: "诊断",
        discard: "丢弃",
        error: "错误",
        failed: "失败",
        failedTasks: "失败任务",
        followCurrent: "跟随当前",
        items: "条",
        language: "语言",
        last: "最近记录",
        lines: "行数",
        loading: "加载中...",
        mode: "模式",
        maxParallel: "最大并行",
        navControls: "控制",
        navFailures: "失败任务",
        navOverview: "概览",
        navRecords: "记录",
        navRuns: "运行",
        noData: "暂无数据",
        prompt: "消息",
        ready: "就绪。",
        recentRuns: "最近运行",
        records: "记录",
        refresh: "刷新",
        retry: "重试",
        running: "运行中",
        run: "运行",
        runDiagnostics: "运行诊断",
        selectedConversation: "固定对话",
        session: "会话",
        sessionId: "会话 ID",
        stateRoot: "状态目录",
        stderr: "错误输出",
        stdout: "标准输出",
        switchModel: "切换模型",
        time: "时间",
        title: "桥控制台",
        transcriptMirrors: "记录镜像"
      }
    };

    let latestData;
    let statusText = "";
    let statusTone = "";
    let busy = false;
    let language = localStorage.getItem("codex-weixin-console-language") || "zh-CN";
    if (!I18N[language]) {
      language = "zh-CN";
    }

    $("language").value = language;
    $("language").addEventListener("change", () => {
      language = $("language").value;
      localStorage.setItem("codex-weixin-console-language", language);
      applyStaticText();
      if (latestData) {
        renderAll(latestData);
      }
    });
    $("refresh").addEventListener("click", () => {
      load().catch((error) => setStatus(error.message || String(error), "danger"));
    });
    $("model").addEventListener("change", () => {
      localStorage.setItem("codex-weixin-console-model", $("model").value);
    });
    $("switch-model").addEventListener("click", () => {
      switchModel().catch((error) => setStatus(error.message || String(error), "danger"));
    });
    $("run-diagnostics").addEventListener("click", () => {
      runDiagnostics().catch((error) => setStatus(error.message || String(error), "danger"));
    });
    $("detect-composer").addEventListener("click", () => {
      detectComposer().catch((error) => setStatus(error.message || String(error), "danger"));
    });

    applyStaticText();
    load().catch((error) => setStatus(error.message || String(error), "danger"));
    setInterval(() => {
      load().catch((error) => setStatus(error.message || String(error), "danger"));
    }, 10000);

    function t(key) {
      return (I18N[language] && I18N[language][key]) || I18N.en[key] || key;
    }

    function applyStaticText() {
      document.documentElement.lang = language;
      document.querySelectorAll("[data-i18n]").forEach((node) => {
        node.textContent = t(node.getAttribute("data-i18n"));
      });
      renderStatus();
    }

    async function load() {
      const response = await fetch("/api/status", { cache: "no-store" });
      const data = await response.json();
      latestData = data;
      renderAll(data);
    }

    function renderAll(data) {
      renderOverview(data);
      renderFailures(data.failedTasks || []);
      renderRecords(data.transcripts || []);
      renderRuns(data.recentRuns || []);
      renderModelOptions(data.allowedDesktopModels || []);
    }

    function renderOverview(data) {
      const agentStatus = data.agentStatus || {};
      const configRiskCount = Number(data.configRiskCount || 0);
      $("overview").innerHTML = [
        card(t("bridge"), t("running"), "ok"),
        card(t("mode"), data.deliveryMode || ""),
        card(t("agentMode"), agentStatus.mode || ""),
        card(t("maxParallel"), String(agentStatus.maxParallel || "")),
        card(t("agentQueue"), String(agentStatus.activeCount || 0) + "/" + String(agentStatus.maxParallel || 1) + " / " + String(agentStatus.queuedCount || 0)),
        card(t("configHealth"), configRiskCount === 0 ? "OK" : String(configRiskCount) + " " + t("configRisks"), configRiskCount === 0 ? "ok" : "warn"),
        card(t("failed"), String((data.failedTasks || []).length), (data.failedTasks || []).length ? "danger" : "ok"),
        card(t("stateRoot"), data.logRoot || "")
      ].join("");
    }

    function renderModelOptions(models) {
      const select = $("model");
      const list = Array.isArray(models) ? models : [];
      const current = select.value;
      const saved = localStorage.getItem("codex-weixin-console-model") || "";
      const preferred = list.includes(saved) ? saved : (list.includes(current) ? current : (list[0] || ""));
      select.innerHTML = list.map((item) => "<option value='" + esc(item) + "'>" + esc(item) + "</option>").join("");
      select.disabled = list.length === 0 || busy;
      if (preferred) {
        select.value = preferred;
      }
    }

    async function switchModel() {
      const model = $("model").value;
      if (!model) {
        setStatus(t("noData"), "warn");
        return;
      }

      setBusy(true);
      try {
        const response = await fetch("/api/desktop-model", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model })
        });
        const data = await response.json();
        const tone = data.ok ? "ok" : "danger";
        const details = [];
        if (data.message) {
          details.push(String(data.message));
        }
        if (data.status) {
          details.push("status: " + String(data.status));
        }
        setStatus(details.join("\\n"), tone);
        await load();
      } finally {
        setBusy(false);
      }
    }

    async function runDiagnostics() {
      setBusy(true);
      try {
        const response = await fetch("/api/diagnostics", { cache: "no-store" });
        const data = await response.json();
        const checks = Array.isArray(data.checks) ? data.checks : [];
        const lines = checks.map((item) => {
          const mark = item.ok ? "[OK]" : (item.severity === "error" ? "[ERROR]" : "[WARN]");
          const fix = item.fix ? " | fix: " + String(item.fix) : "";
          return mark + " " + String(item.label || "") + ": " + String(item.detail || "") + fix;
        });
        if (data.latestRun && data.latestRun.name) {
          lines.push("latest run: " + String(data.latestRun.name));
        }
        setStatus(lines.join("\\n") || t("noData"), checks.every((item) => item.ok) ? "ok" : "warn");
      } finally {
        setBusy(false);
      }
    }

    async function detectComposer() {
      setBusy(true);
      try {
        const response = await fetch("/api/desktop-input/detect", { method: "POST" });
        const data = await response.json();
        const lines = [];
        if (data.message) {
          lines.push(String(data.message));
        }
        if (data.promptPath) {
          lines.push("probe: " + String(data.promptPath));
        }
        setStatus(lines.join("\\n") || t("noData"), data.ok ? "ok" : "danger");
      } finally {
        setBusy(false);
      }
    }

    function renderFailures(items) {
      const panel = $("failures");
      const rows = Array.isArray(items) ? items : [];
      if (!rows.length) {
        panel.innerHTML = panelHeading(t("failedTasks"), 0) + "<div class='empty'>" + esc(t("noData")) + "</div>";
        return;
      }

      panel.innerHTML = panelHeading(t("failedTasks"), rows.length)
        + "<div class='failure-list'>"
        + rows.map((item) => {
          const sessionKey = String(item.sessionKey || "");
          return "<article class='failure-item'>"
            + "<div class='failure-main'>"
            + "<div class='failure-meta'>"
            + "<code>" + esc(item.timestamp || "") + "</code>"
            + "<span class='session-chip' title='" + esc(sessionKey) + "'>" + esc(shortenMiddle(sessionKey, 42)) + "</span>"
            + "</div>"
            + "<div class='failure-prompt'>"
            + "<span class='failure-label'>" + esc(t("prompt")) + "</span>"
            + "<code>" + esc(item.prompt || "") + "</code>"
            + "</div>"
            + "<details class='failure-details'>"
            + "<summary>" + esc(t("details")) + "</summary>"
            + "<span class='failure-label'>" + esc(t("error")) + "</span>"
            + "<code>" + esc(item.error || "") + "</code>"
            + "<span class='failure-label'>" + esc(t("sessionId")) + "</span>"
            + "<code>" + esc(sessionKey) + "</code>"
            + "</details>"
            + "</div>"
            + "<div class='row-actions failure-actions'>"
            + "<button class='small' data-action='retry' data-id='" + esc(item.id || "") + "' data-session='" + esc(sessionKey) + "'>" + esc(t("retry")) + "</button>"
            + "<button class='small danger' data-action='discard' data-id='" + esc(item.id || "") + "' data-session='" + esc(sessionKey) + "'>" + esc(t("discard")) + "</button>"
            + "<button class='small' data-action='archive' data-session='" + esc(sessionKey) + "'>" + esc(t("archiveFailures")) + "</button>"
            + "<button class='small danger' data-action='clear' data-session='" + esc(sessionKey) + "'>" + esc(t("clearFailures")) + "</button>"
            + "</div>"
            + "</article>";
        }).join("")
        + "</div>";

      panel.querySelectorAll("button[data-action]").forEach((button) => {
        button.disabled = busy;
        button.addEventListener("click", () => {
          const action = button.getAttribute("data-action");
          const sessionKey = button.getAttribute("data-session") || "";
          const id = button.getAttribute("data-id") || "";
          if (action === "retry") {
            retryFailedTask(sessionKey, id).catch((error) => setStatus(error.message || String(error), "danger"));
            return;
          }
          if (action === "discard") {
            discardFailedTask(sessionKey, id).catch((error) => setStatus(error.message || String(error), "danger"));
            return;
          }
          if (action === "archive") {
            archiveFailedTasks(sessionKey).catch((error) => setStatus(error.message || String(error), "danger"));
            return;
          }
          if (action === "clear") {
            clearFailedTasks(sessionKey).catch((error) => setStatus(error.message || String(error), "danger"));
          }
        });
      });
    }

    async function retryFailedTask(sessionKey, id) {
      if (!sessionKey || !id) {
        setStatus(t("noData"), "warn");
        return;
      }

      setBusy(true);
      try {
        const response = await fetch("/api/failed/retry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, sessionKey })
        });
        const data = await response.json();
        const parts = [String(data.message || "")];
        if (data.lastMessage) {
          parts.push(String(data.lastMessage));
        }
        setStatus(parts.filter(Boolean).join("\\n"), data.ok ? "ok" : "danger");
        await load();
      } finally {
        setBusy(false);
      }
    }

    async function discardFailedTask(sessionKey, id) {
      if (!sessionKey || !id) {
        setStatus(t("noData"), "warn");
        return;
      }

      setBusy(true);
      try {
        const response = await fetch("/api/failed/discard", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, sessionKey })
        });
        const data = await response.json();
        setStatus(String(data.message || ""), data.ok ? "ok" : "danger");
        await load();
      } finally {
        setBusy(false);
      }
    }

    async function clearFailedTasks(sessionKey) {
      if (!sessionKey) {
        setStatus(t("noData"), "warn");
        return;
      }

      setBusy(true);
      try {
        const response = await fetch("/api/failed/clear", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionKey })
        });
        const data = await response.json();
        setStatus(String(data.message || ""), data.ok ? "ok" : "danger");
        await load();
      } finally {
        setBusy(false);
      }
    }

    async function archiveFailedTasks(sessionKey) {
      if (!sessionKey) {
        setStatus(t("noData"), "warn");
        return;
      }

      setBusy(true);
      try {
        const response = await fetch("/api/failed/archive", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionKey })
        });
        const data = await response.json();
        setStatus(String(data.message || ""), data.ok ? "ok" : "danger");
        await load();
      } finally {
        setBusy(false);
      }
    }

    function renderRecords(items) {
      setPanel("records", t("transcriptMirrors"), items, [t("session"), t("selectedConversation"), t("lines"), t("last")], (item) => [
        item.sessionKey,
        item.selectedCodexSessionId || t("followCurrent"),
        String(item.lineCount),
        (item.lastTimestamp || "") + " " + (item.lastTextPreview || "")
      ]);
    }

    function renderRuns(items) {
      setPanel("runs", t("recentRuns"), items, [t("run"), t("stdout"), t("stderr")], (item) => [
        item.name,
        item.stdoutPreview || item.lastMessagePreview || "",
        item.stderrPreview || ""
      ]);
    }

    function setPanel(id, title, rows, headers, mapRow) {
      const panel = $(id);
      if (!rows.length) {
        panel.innerHTML = panelHeading(title, 0) + "<div class='empty'>" + esc(t("noData")) + "</div>";
        return;
      }

      panel.innerHTML = panelHeading(title, rows.length) + "<div class='table-scroll'><table><thead><tr>"
        + headers.map((header) => "<th>" + esc(header) + "</th>").join("")
        + "</tr></thead><tbody>"
        + rows.map((row) => "<tr>" + mapRow(row).map((cell) => "<td><code>" + esc(String(cell || "")) + "</code></td>").join("") + "</tr>").join("")
        + "</tbody></table></div>";
    }

    function panelHeading(title, count) {
      return "<div class='panel-header'><h3>" + esc(title) + "</h3>"
        + "<span class='count-pill'>" + esc(String(count)) + " " + esc(t("items")) + "</span></div>";
    }

    function shortenMiddle(value, maxLength) {
      const text = String(value || "");
      const limit = Number(maxLength) || 42;
      if (text.length <= limit) {
        return text;
      }
      const edge = Math.max(6, Math.floor((limit - 3) / 2));
      return text.slice(0, edge) + "..." + text.slice(-edge);
    }

    function setStatus(text, tone) {
      statusText = text;
      statusTone = tone || "";
      renderStatus();
    }

    function renderStatus() {
      const box = $("action-status");
      box.className = "status-box";
      if (statusTone) {
        box.classList.add(statusTone);
      }
      box.textContent = statusText || t("ready");
    }

    function setBusy(next) {
      busy = Boolean(next);
      $("refresh").disabled = busy;
      $("switch-model").disabled = busy;
      $("run-diagnostics").disabled = busy;
      $("detect-composer").disabled = busy;
      $("model").disabled = busy || !$("model").options.length;
      document.querySelectorAll("button[data-action]").forEach((button) => {
        button.disabled = busy;
      });
    }

    function card(label, value, cls) {
      const extraClass = cls ? (" " + cls) : "";
      return "<article class='card'><div class='label'>" + esc(label)
        + "</div><div class='value" + extraClass + "'>" + esc(value)
        + "</div></article>";
    }

    function esc(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    }
  </script>
</body>
</html>`;
}
