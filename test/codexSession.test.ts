import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { findLatestDesktopSessionId, findSessionPathById, listDesktopSessions } from "../src/codexSession.js";

const tempRoots: string[] = [];

describe("findLatestDesktopSessionId", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("selects the newest Codex Desktop session for the bridge cwd", () => {
    const codexHome = makeTempCodexHome();
    const targetCwd = "C:\\Users\\roy\\Documents\\New project 4";

    writeSession(codexHome, "2026", "05", "04", "older", {
      id: "older-session",
      cwd: targetCwd,
      originator: "Codex Desktop"
    }, new Date("2026-05-04T10:00:00Z"));
    writeSession(codexHome, "2026", "05", "05", "ignored-cli", {
      id: "cli-session",
      cwd: targetCwd,
      originator: "Codex CLI"
    }, new Date("2026-05-05T10:00:00Z"));
    writeSession(codexHome, "2026", "05", "05", "ignored-cwd", {
      id: "other-cwd-session",
      cwd: "D:\\Other",
      originator: "Codex Desktop"
    }, new Date("2026-05-05T11:00:00Z"));
    writeSession(codexHome, "2026", "05", "05", "newer", {
      id: "newer-session",
      cwd: targetCwd.toLowerCase(),
      originator: "Codex Desktop"
    }, new Date("2026-05-05T12:00:00Z"));
    writeSession(codexHome, "2026", "05", "05", "ignored-subagent", {
      id: "subagent-session",
      cwd: targetCwd,
      originator: "Codex Desktop",
      source: { subagent: {} }
    }, new Date("2026-05-05T13:00:00Z"));

    expect(findLatestDesktopSessionId({ codexHome, codexCwd: targetCwd })).toBe("newer-session");
  });

  it("returns undefined when no matching desktop session exists", () => {
    const codexHome = makeTempCodexHome();

    expect(findLatestDesktopSessionId({
      codexHome,
      codexCwd: "C:\\Users\\roy\\Documents\\New project 4"
    })).toBeUndefined();
  });

  it("finds a persisted session path by id", () => {
    const codexHome = makeTempCodexHome();
    writeSession(codexHome, "2026", "05", "05", "target", {
      id: "target-session",
      cwd: "C:\\Users\\roy\\Documents\\New project 4",
      originator: "Codex Desktop"
    }, new Date("2026-05-05T12:00:00Z"));

    expect(findSessionPathById(codexHome, "target-session")).toMatch(/rollout-target\.jsonl$/);
  });

  it("lists recent main desktop conversations across workspaces", () => {
    const codexHome = makeTempCodexHome();
    writeSession(codexHome, "2026", "05", "05", "older", {
      id: "older-session",
      cwd: "C:\\Project A",
      originator: "Codex Desktop"
    }, new Date("2026-05-05T12:00:00Z"), "第一个需求");
    writeSession(codexHome, "2026", "05", "06", "newer", {
      id: "newer-session",
      cwd: "C:\\Project B",
      originator: "Codex Desktop"
    }, new Date("2026-05-06T12:00:00Z"), "第二个需求");
    writeSession(codexHome, "2026", "05", "06", "ignored-subagent", {
      id: "subagent-session",
      cwd: "C:\\Project B",
      originator: "Codex Desktop",
      source: { subagent: {} }
    }, new Date("2026-05-06T13:00:00Z"), "子代理任务");

    expect(listDesktopSessions({ codexHome }).map((session) => ({
      id: session.id,
      cwd: session.cwd,
      title: session.title
    }))).toEqual([
      { id: "newer-session", cwd: "C:\\Project B", title: "第二个需求" },
      { id: "older-session", cwd: "C:\\Project A", title: "第一个需求" }
    ]);
  });

  it("skips injected AGENTS briefing text when choosing a conversation title", () => {
    const codexHome = makeTempCodexHome();
    writeSession(codexHome, "2026", "05", "05", "target", {
      id: "target-session",
      cwd: "C:\\Project A",
      originator: "Codex Desktop"
    }, new Date("2026-05-05T12:00:00Z"), "# AGENTS.md instructions for C:\\Project A\n<INSTRUCTIONS>");
    appendUserMessage(codexHome, "2026", "05", "05", "target", "真正的问题");

    expect(listDesktopSessions({ codexHome })[0]?.title).toBe("真正的问题");
  });
});

function makeTempCodexHome(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  tempRoots.push(root);
  return root;
}

function writeSession(
  codexHome: string,
  year: string,
  month: string,
  day: string,
  name: string,
  payload: { id: string; cwd: string; originator: string; source?: unknown },
  mtime: Date,
  firstUserMessage?: string
): void {
  const dir = path.join(codexHome, "sessions", year, month, day);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-${name}.jsonl`);
  const lines = [`${JSON.stringify({
    timestamp: mtime.toISOString(),
    type: "session_meta",
    payload
  })}`];
  if (firstUserMessage) {
    lines.push(`${JSON.stringify({
      timestamp: mtime.toISOString(),
      type: "event_msg",
      payload: { type: "user_message", message: firstUserMessage }
    })}`);
  }
  writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
  utimesSync(filePath, mtime, mtime);
}

function appendUserMessage(
  codexHome: string,
  year: string,
  month: string,
  day: string,
  name: string,
  message: string
): void {
  const filePath = path.join(codexHome, "sessions", year, month, day, `rollout-${name}.jsonl`);
  const original = readFileSync(filePath, "utf8");
  writeFileSync(filePath, `${original}${JSON.stringify({
    timestamp: new Date("2026-05-05T12:01:00Z").toISOString(),
    type: "event_msg",
    payload: { type: "user_message", message }
  })}\n`, "utf8");
}
