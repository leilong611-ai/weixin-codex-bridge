import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  extractTaskCompleteMessage,
  extractUserMessage,
  waitForTaskCompleteMessage,
  waitForUserMessage
} from "../src/codexTranscript.js";

const tempRoots: string[] = [];

describe("extractTaskCompleteMessage", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("returns the last completed agent message from appended session text", () => {
    const appended = [
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "progress" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "final reply" } })
    ].join("\n");

    expect(extractTaskCompleteMessage(appended)).toBe("final reply");
  });

  it("ignores malformed and unrelated lines", () => {
    const appended = [
      "{not-json",
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "" } })
    ].join("\n");

    expect(extractTaskCompleteMessage(appended)).toBeUndefined();
  });

  it("detects an exact user message in appended desktop session text", () => {
    const appended = [
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "progress" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "微信原文" } })
    ].join("\n");

    expect(extractUserMessage(appended, "微信原文")).toBe("微信原文");
  });

  it("detects an exact user response item in appended desktop session text", () => {
    const appended = [
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "微信原文\n" }]
        }
      })
    ].join("\n");

    expect(extractUserMessage(appended, "微信原文")).toBe("微信原文\n");
  });

  it("waits until the desktop session records the exact pasted user message", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "codex-transcript-"));
    tempRoots.push(root);
    const sessionPath = path.join(root, "session.jsonl");
    writeFileSync(sessionPath, "before\n", "utf8");
    const startOffset = 7;

    setTimeout(() => {
      appendFileSync(
        sessionPath,
        `${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "微信原文" } })}\n`,
        "utf8"
      );
    }, 10);

    await expect(waitForUserMessage(sessionPath, startOffset, "微信原文", 1000)).resolves.toBe("微信原文");
  });

  it("uses byte offsets when reading appended UTF-8 session content", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "codex-transcript-"));
    tempRoots.push(root);
    const sessionPath = path.join(root, "session.jsonl");
    const prefix = "已有中文\n";
    writeFileSync(sessionPath, prefix, "utf8");
    const startOffset = Buffer.byteLength(prefix, "utf8");
    appendFileSync(
      sessionPath,
      `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "final reply" } })}\n`,
      "utf8"
    );

    await expect(waitForTaskCompleteMessage(sessionPath, startOffset, 1000)).resolves.toBe("final reply");
  });

  it("falls back to the latest agent message when task_complete has no final text", () => {
    const appended = [
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "visible reply" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "" } })
    ].join("\n");

    expect(extractTaskCompleteMessage(appended)).toBe("visible reply");
  });
});
