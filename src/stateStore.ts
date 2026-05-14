import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import path from "node:path";

import type { BridgeConfig } from "./config.js";

interface SyncState {
  get_updates_buf?: string;
}

export type SyncStateSource = "local" | "openclaw" | "empty";

export interface LoadedSyncState {
  getUpdatesBuf: string;
  source: SyncStateSource;
}

export interface MirrorEvent {
  accountId: string;
  direction: "inbound" | "outbound" | "system";
  messageId?: number | string;
  peerId: string;
  sessionKey: string;
  text: string;
  timestamp: string;
  weixinCreateTimeMs?: number;
}

export interface FailedTask {
  accountId: string;
  error: string;
  id: string;
  messageId?: number | string;
  peerId: string;
  prompt: string;
  runDirectory?: string;
  sessionKey: string;
  timestamp: string;
  weixinCreateTimeMs?: number;
}

export interface ArchivedFailedTask extends FailedTask {
  archivedAt: string;
}

export interface RunSummary {
  actualSessionId?: string;
  lastMessagePreview?: string;
  lastWriteTimeMs: number;
  name: string;
  path: string;
  stderrPreview: string;
  stdoutPreview: string;
}

export interface TranscriptSummary {
  lastDirection?: MirrorEvent["direction"];
  lastTextPreview: string;
  lastTimestamp?: string;
  lineCount: number;
  path: string;
  selectedCodexSessionId?: string;
  sessionKey: string;
}

export class BridgeStateStore {
  constructor(private readonly config: BridgeConfig) {}

  get root(): string {
    return this.config.logRoot;
  }

  private async ensureDir(...pieces: string[]): Promise<string> {
    const dir = path.join(this.root, ...pieces);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  private syncPath(accountId: string): string {
    return path.join(this.root, "state", `${accountId}.sync.json`);
  }

  private openClawSyncPath(accountId: string): string {
    return path.join(this.config.openclawStateRoot, "openclaw-weixin", "accounts", `${accountId}.sync.json`);
  }

  private selectedSessionPath(sessionKey: string): string {
    return path.join(this.root, "state", "codex-sessions", `${sanitizeStateKey(sessionKey)}.json`);
  }

  private lastPromptPath(sessionKey: string): string {
    return path.join(this.root, "state", "last-prompts", `${sanitizeStateKey(sessionKey)}.json`);
  }

  private mirrorTranscriptPath(sessionKey: string): string {
    return path.join(this.root, "transcripts", `${sessionKey}.jsonl`);
  }

  private failedTasksPath(sessionKey: string): string {
    return path.join(this.root, "state", "failed-tasks", `${sanitizeStateKey(sessionKey)}.json`);
  }

  private archivedFailedTasksPath(sessionKey: string): string {
    return path.join(this.root, "state", "failed-task-archive", `${sanitizeStateKey(sessionKey)}.jsonl`);
  }

  async loadSyncBuf(accountId: string): Promise<string> {
    return (await this.loadSyncState(accountId)).getUpdatesBuf;
  }

  async loadSyncState(accountId: string): Promise<LoadedSyncState> {
    await this.ensureDir("state");
    const local = await this.readSyncFile(this.syncPath(accountId));
    if (local) {
      return { getUpdatesBuf: local, source: "local" };
    }

    const openclaw = await this.readSyncFile(this.openClawSyncPath(accountId));
    if (openclaw) {
      return { getUpdatesBuf: openclaw, source: "openclaw" };
    }

    return { getUpdatesBuf: "", source: "empty" };
  }

  async saveSyncBuf(accountId: string, getUpdatesBuf: string): Promise<void> {
    await this.ensureDir("state");
    await writeFile(this.syncPath(accountId), `${JSON.stringify({ get_updates_buf: getUpdatesBuf })}\n`, "utf8");
  }

  async loadSelectedCodexSession(sessionKey: string): Promise<string | undefined> {
    const filePath = this.selectedSessionPath(sessionKey);
    if (!existsSync(filePath)) {
      return undefined;
    }

    const parsed = JSON.parse(await readFile(filePath, "utf8")) as { codexSessionId?: unknown };
    return typeof parsed.codexSessionId === "string" && parsed.codexSessionId.trim()
      ? parsed.codexSessionId
      : undefined;
  }

  async saveSelectedCodexSession(sessionKey: string, codexSessionId: string): Promise<void> {
    await this.ensureDir("state", "codex-sessions");
    await writeFile(
      this.selectedSessionPath(sessionKey),
      `${JSON.stringify({ codexSessionId })}\n`,
      "utf8"
    );
  }

  async clearSelectedCodexSession(sessionKey: string): Promise<void> {
    await rm(this.selectedSessionPath(sessionKey), { force: true });
  }

  async loadLastPrompt(sessionKey: string): Promise<string | undefined> {
    const filePath = this.lastPromptPath(sessionKey);
    if (!existsSync(filePath)) {
      return undefined;
    }

    const parsed = JSON.parse(await readFile(filePath, "utf8")) as { prompt?: unknown };
    return typeof parsed.prompt === "string" && parsed.prompt.trim()
      ? parsed.prompt
      : undefined;
  }

  async saveLastPrompt(sessionKey: string, prompt: string): Promise<void> {
    await this.ensureDir("state", "last-prompts");
    await writeFile(
      this.lastPromptPath(sessionKey),
      `${JSON.stringify({ prompt })}\n`,
      "utf8"
    );
  }

  async listMirrorEvents(sessionKey: string, options: number | { limit?: number; query?: string } = 8): Promise<MirrorEvent[]> {
    const filePath = this.mirrorTranscriptPath(sessionKey);
    if (!existsSync(filePath)) {
      return [];
    }

    const limit = typeof options === "number" ? options : options.limit ?? 8;
    const query = typeof options === "number" ? "" : options.query?.trim().toLowerCase() ?? "";
    const events: MirrorEvent[] = [];
    const lines = (await readFile(filePath, "utf8")).split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      try {
        const parsed = JSON.parse(line) as unknown;
        if (isMirrorEvent(parsed)) {
          events.push(parsed);
        }
      } catch {
        // Session mirrors can contain a partial line if the bridge was interrupted mid-write.
      }
    }

    const filtered = query
      ? events.filter((event) => event.text.toLowerCase().includes(query))
      : events;
    return filtered.slice(Math.max(filtered.length - limit, 0));
  }

  async listFailedTasks(sessionKey: string): Promise<FailedTask[]> {
    const filePath = this.failedTasksPath(sessionKey);
    if (!existsSync(filePath)) {
      return [];
    }

    const parsed = JSON.parse(await readFile(filePath, "utf8")) as { tasks?: unknown };
    return Array.isArray(parsed.tasks)
      ? parsed.tasks.filter(isFailedTask)
      : [];
  }

  async saveFailedTask(task: FailedTask): Promise<void> {
    await this.ensureDir("state", "failed-tasks");
    const tasks = await this.listFailedTasks(task.sessionKey);
    tasks.push(task);
    await this.writeFailedTasks(task.sessionKey, tasks);
  }

  async takeFailedTask(sessionKey: string, index: number): Promise<FailedTask | undefined> {
    const tasks = await this.listFailedTasks(sessionKey);
    const task = tasks[index];
    if (!task) {
      return undefined;
    }

    tasks.splice(index, 1);
    await this.writeFailedTasks(sessionKey, tasks);
    return task;
  }

  async takeFailedTaskById(sessionKey: string, id: string): Promise<FailedTask | undefined> {
    const tasks = await this.listFailedTasks(sessionKey);
    const index = tasks.findIndex((task) => task.id === id);
    if (index < 0) {
      return undefined;
    }

    const [task] = tasks.splice(index, 1);
    await this.writeFailedTasks(sessionKey, tasks);
    return task;
  }

  async discardFailedTask(sessionKey: string, index: number): Promise<FailedTask | undefined> {
    return await this.takeFailedTask(sessionKey, index);
  }

  async discardFailedTaskById(sessionKey: string, id: string): Promise<FailedTask | undefined> {
    return await this.takeFailedTaskById(sessionKey, id);
  }

  async clearFailedTasks(sessionKey: string): Promise<number> {
    const tasks = await this.listFailedTasks(sessionKey);
    if (tasks.length === 0) {
      return 0;
    }

    await this.writeFailedTasks(sessionKey, []);
    return tasks.length;
  }

  async archiveFailedTasks(sessionKey: string): Promise<number> {
    const tasks = await this.listFailedTasks(sessionKey);
    if (tasks.length === 0) {
      return 0;
    }

    await this.ensureDir("state", "failed-task-archive");
    const filePath = this.archivedFailedTasksPath(sessionKey);
    const archivedAt = new Date().toISOString();
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(filePath, { flags: "a", encoding: "utf8" });
      stream.on("error", reject);
      stream.on("finish", resolve);
      stream.end(tasks.map((task) => JSON.stringify({ ...task, archivedAt })).join("\n") + "\n");
    });
    await this.writeFailedTasks(sessionKey, []);
    return tasks.length;
  }

  async listArchivedFailedTasks(sessionKey: string): Promise<ArchivedFailedTask[]> {
    const filePath = this.archivedFailedTasksPath(sessionKey);
    if (!existsSync(filePath)) {
      return [];
    }

    const tasks: ArchivedFailedTask[] = [];
    const lines = (await readFile(filePath, "utf8")).split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      try {
        const parsed = JSON.parse(line) as unknown;
        if (isArchivedFailedTask(parsed)) {
          tasks.push(parsed);
        }
      } catch {
        // Ignore partial archive lines.
      }
    }
    return tasks;
  }

  async listRecentRuns(limit = 5): Promise<RunSummary[]> {
    const runsRoot = path.join(this.root, "runs");
    let entries;
    try {
      entries = await readdir(runsRoot, { withFileTypes: true });
    } catch {
      return [];
    }

    const runs: RunSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const runPath = path.join(runsRoot, entry.name);
      const info = await stat(runPath);
      runs.push({
        actualSessionId: await readActualSessionId(path.join(runPath, "actual-session.json")),
        lastMessagePreview: await readPreview(path.join(runPath, "last-message.txt")),
        lastWriteTimeMs: info.mtimeMs,
        name: entry.name,
        path: runPath,
        stderrPreview: await readPreview(path.join(runPath, "stderr.log")),
        stdoutPreview: await readPreview(path.join(runPath, "stdout.log"))
      });
    }

    runs.sort((left, right) => right.lastWriteTimeMs - left.lastWriteTimeMs);
    return runs.slice(0, limit);
  }

  async listAllFailedTasks(limit = 20): Promise<FailedTask[]> {
    const dir = path.join(this.root, "state", "failed-tasks");
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const tasks: FailedTask[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      try {
        const parsed = JSON.parse(await readFile(path.join(dir, entry.name), "utf8")) as { tasks?: unknown };
        if (Array.isArray(parsed.tasks)) {
          tasks.push(...parsed.tasks.filter(isFailedTask));
        }
      } catch {
        // Ignore damaged failure state files; diagnostics should keep working.
      }
    }

    tasks.sort((left, right) => right.timestamp.localeCompare(left.timestamp));
    return tasks.slice(0, limit);
  }

  async listTranscriptSummaries(limit = 20): Promise<TranscriptSummary[]> {
    const dir = path.join(this.root, "transcripts");
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const summaries: TranscriptSummary[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      const filePath = path.join(dir, entry.name);
      const lines = (await readFile(filePath, "utf8")).split(/\r?\n/).filter((line) => line.trim());
      let lastEvent: MirrorEvent | undefined;
      for (const line of [...lines].reverse()) {
        try {
          const parsed = JSON.parse(line) as unknown;
          if (isMirrorEvent(parsed)) {
            lastEvent = parsed;
            break;
          }
        } catch {
          // Ignore partial lines.
        }
      }

      summaries.push({
        lastDirection: lastEvent?.direction,
        lastTextPreview: lastEvent ? preview(lastEvent.text) : "",
        lastTimestamp: lastEvent?.timestamp,
        lineCount: lines.length,
        path: filePath,
        selectedCodexSessionId: await this.loadSelectedCodexSession(entry.name.replace(/\.jsonl$/, "")),
        sessionKey: entry.name.replace(/\.jsonl$/, "")
      });
    }

    summaries.sort((left, right) => (right.lastTimestamp ?? "").localeCompare(left.lastTimestamp ?? ""));
    return summaries.slice(0, limit);
  }

  async appendMirrorEvent(event: MirrorEvent): Promise<void> {
    await this.ensureDir("transcripts");
    const filePath = this.mirrorTranscriptPath(event.sessionKey);
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(filePath, { flags: "a", encoding: "utf8" });
      stream.on("error", reject);
      stream.on("finish", resolve);
      stream.end(`${JSON.stringify(event)}\n`);
    });
  }

  async createRunDirectory(label: string): Promise<string> {
    const dir = await this.ensureDir("runs");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const cleanLabel = label.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "run";
    const runDir = path.join(dir, `${stamp}-${cleanLabel}`);
    await mkdir(runDir, { recursive: true });
    return runDir;
  }

  private async readSyncFile(filePath: string): Promise<string | null> {
    if (!existsSync(filePath)) {
      return null;
    }

    const parsed = JSON.parse(await readFile(filePath, "utf8")) as SyncState;
    return typeof parsed.get_updates_buf === "string" ? parsed.get_updates_buf : null;
  }

  private async writeFailedTasks(sessionKey: string, tasks: FailedTask[]): Promise<void> {
    await this.ensureDir("state", "failed-tasks");
    await writeFile(
      this.failedTasksPath(sessionKey),
      `${JSON.stringify({ tasks }, null, 2)}\n`,
      "utf8"
    );
  }
}

function sanitizeStateKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "session";
}

function isMirrorEvent(value: unknown): value is MirrorEvent {
  if (!value || typeof value !== "object") {
    return false;
  }

  const event = value as Partial<MirrorEvent>;
  return typeof event.accountId === "string" &&
    (event.direction === "inbound" || event.direction === "outbound" || event.direction === "system") &&
    typeof event.peerId === "string" &&
    typeof event.sessionKey === "string" &&
    typeof event.text === "string" &&
    typeof event.timestamp === "string";
}

function isFailedTask(value: unknown): value is FailedTask {
  if (!value || typeof value !== "object") {
    return false;
  }

  const task = value as Partial<FailedTask>;
  return typeof task.accountId === "string" &&
    typeof task.error === "string" &&
    typeof task.id === "string" &&
    typeof task.peerId === "string" &&
    typeof task.prompt === "string" &&
    typeof task.sessionKey === "string" &&
    typeof task.timestamp === "string";
}

function isArchivedFailedTask(value: unknown): value is ArchivedFailedTask {
  return isFailedTask(value) &&
    typeof (value as Partial<ArchivedFailedTask>).archivedAt === "string";
}

async function readPreview(filePath: string, maxLength = 180): Promise<string> {
  if (!existsSync(filePath)) {
    return "";
  }

  return preview(await readFile(filePath, "utf8"), maxLength);
}

async function readActualSessionId(filePath: string): Promise<string | undefined> {
  if (!existsSync(filePath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as { id?: unknown };
    return typeof parsed.id === "string" ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

function preview(text: string, maxLength = 180): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}
