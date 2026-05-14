import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface FindLatestDesktopSessionOptions {
  codexHome: string;
  codexCwd: string;
}

interface SessionCandidate {
  id: string;
  mtimeMs: number;
}

export interface DesktopSession {
  cwd: string;
  id: string;
  mtimeMs: number;
  path: string;
  title: string;
}

export function findLatestDesktopSessionId(options: FindLatestDesktopSessionOptions): string | undefined {
  const candidates: SessionCandidate[] = [];

  for (const session of listDesktopSessions({
    codexHome: options.codexHome,
    codexCwd: options.codexCwd
  })) {
    candidates.push({
      id: session.id,
      mtimeMs: session.mtimeMs
    });
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.id;
}

export function findSessionPathById(codexHome: string, sessionId: string): string | undefined {
  for (const session of listDesktopSessions({ codexHome })) {
    if (session.id === sessionId) {
      return session.path;
    }
  }

  return undefined;
}

export function listDesktopSessions(options: {
  codexHome: string;
  codexCwd?: string;
  limit?: number;
}): DesktopSession[] {
  const wantedCwd = options.codexCwd ? normalizePath(options.codexCwd) : undefined;
  const sessions: DesktopSession[] = [];

  for (const filePath of listJsonlFiles(path.join(options.codexHome, "sessions"))) {
    const meta = readSessionMeta(filePath);
    if (!meta) {
      continue;
    }

    if (meta.originator !== "Codex Desktop" || meta.isSubagent) {
      continue;
    }

    if (wantedCwd && normalizePath(meta.cwd) !== wantedCwd) {
      continue;
    }

    sessions.push({
      cwd: meta.cwd,
      id: meta.id,
      mtimeMs: statSync(filePath).mtimeMs,
      path: filePath,
      title: readSessionTitle(filePath)
    });
  }

  sessions.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return options.limit ? sessions.slice(0, options.limit) : sessions;
}

function listJsonlFiles(root: string): string[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsonlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }

  return files;
}

function readSessionTitle(filePath: string): string {
  let lines: string[] = [];
  try {
    lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  } catch {
    return "";
  }

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as {
        type?: string;
        payload?: {
          type?: string;
          message?: unknown;
          role?: unknown;
          content?: unknown;
        };
      };
      if (
        parsed.type === "event_msg" &&
        parsed.payload?.type === "user_message" &&
        typeof parsed.payload.message === "string"
      ) {
        const title = compactTitle(parsed.payload.message);
        if (isUsefulTitle(title)) {
          return title;
        }
      }

      if (
        parsed.type === "response_item" &&
        parsed.payload?.type === "message" &&
        parsed.payload.role === "user" &&
        Array.isArray(parsed.payload.content)
      ) {
        const text = parsed.payload.content
          .map((item) => isInputText(item) ? item.text : "")
          .join("");
        if (text.trim()) {
          const title = compactTitle(text);
          if (isUsefulTitle(title)) {
            return title;
          }
        }
      }
    } catch {
      // Ignore malformed or partial lines.
    }
  }

  return "";
}

function compactTitle(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 80);
}

function isUsefulTitle(title: string): boolean {
  return Boolean(title) &&
    !title.startsWith("# AGENTS.md instructions") &&
    !title.startsWith("<INSTRUCTIONS>");
}

function isInputText(item: unknown): item is { type: string; text: string } {
  return Boolean(
    item &&
      typeof item === "object" &&
      "type" in item &&
      "text" in item &&
      (item as { type?: unknown }).type === "input_text" &&
      typeof (item as { text?: unknown }).text === "string"
  );
}

function readSessionMeta(filePath: string): { id: string; cwd: string; originator: string; isSubagent: boolean } | undefined {
  let firstLine = "";
  try {
    firstLine = readFileSync(filePath, "utf8").split(/\r?\n/, 1)[0] ?? "";
  } catch {
    return undefined;
  }

  try {
    const parsed = JSON.parse(firstLine) as {
      type?: string;
      payload?: {
        id?: unknown;
        cwd?: unknown;
        originator?: unknown;
        source?: unknown;
      };
    };
    if (
      parsed.type !== "session_meta" ||
      typeof parsed.payload?.id !== "string" ||
      typeof parsed.payload.cwd !== "string" ||
      typeof parsed.payload.originator !== "string"
    ) {
      return undefined;
    }

    return {
      id: parsed.payload.id,
      cwd: parsed.payload.cwd,
      originator: parsed.payload.originator,
      isSubagent: isSubagentSource(parsed.payload.source)
    };
  } catch {
    return undefined;
  }
}

function isSubagentSource(source: unknown): boolean {
  return Boolean(
    source &&
      typeof source === "object" &&
      "subagent" in source
  );
}

function normalizePath(filePath: string): string {
  return path.resolve(filePath).toLowerCase();
}
