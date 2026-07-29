import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BridgeConfig } from "../src/config.js";
import { SqliteStore } from "../src/sqliteStore.js";

const tempRoots: string[] = [];

function makeConfig(root: string): BridgeConfig {
  return {
    accountId: undefined,
    allowUnconfiguredDevMode: true,
    autoDesktopSession: false,
    codexCmdPath: "codex.cmd",
    codexCwd: root,
    codexHome: path.join(root, ".codex"),
    codexModel: "gpt-5.4-mini",
    codexSessionId: undefined,
    cliFallbackEnabled: false,
    consoleEnabled: false,
    consolePort: 18790,
    consoleToken: "test",
    defaultDeny: true,
    deliveryMode: "desktop-ui",
    desktopInputScriptPath: "test.ps1",
    desktopModelScriptPath: "test.ps1",
    desktopResponseTimeoutMs: 1000,
    logRoot: path.join(root, "bridge"),
    maxParallelRuns: 1,
    openclawConfigPath: "openclaw.json",
    openclawStateRoot: path.join(root, "openclaw"),
    ownerPeerIds: [],
    allowedPeerIds: [],
    readonlyPeerIds: [],
    pollTimeoutMs: 1000,
    resumeAllSessions: false,
    resumeLast: false,
    skipBacklogOnStart: true,
    weixinChannelVersion: "2.1.1",
    sandboxRoot: "",
    allowedWorkspaceRoots: [],
    executionMode: "high-risk",
    allowFullAuto: false,
    allowSkipGitCheck: false,
    logLevel: "minimal",
    transcriptEnabled: false,
    storeFullPrompts: false,
    dataRetentionDays: 7,
  };
}

describe("SqliteStore", () => {
  let root: string;
  let store: SqliteStore;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "sqlite-store-"));
    tempRoots.push(root);
    store = new SqliteStore(makeConfig(root));
  });

  afterEach(() => {
    store.close();
    for (const r of tempRoots.splice(0)) {
      rmSync(r, { force: true, recursive: true });
    }
  });

  // ---- Metadata ----

  it("stores and retrieves metadata", () => {
    store.setMeta("test-key", "test-value");
    expect(store.getMeta("test-key")).toBe("test-value");
  });

  it("updates existing metadata", () => {
    store.setMeta("key", "v1");
    store.setMeta("key", "v2");
    expect(store.getMeta("key")).toBe("v2");
  });

  // ---- Inbox durability & dedup ----

  it("inserts and claims messages in order", () => {
    store.insertInboxMessage({ messageUid: "msg:1", peerId: "user-a", rawJson: "{}", text: "hello" });
    store.insertInboxMessage({ messageUid: "msg:2", peerId: "user-a", rawJson: "{}", text: "world" });

    const first = store.claimNextMessage(60_000);
    expect(first).not.toBeNull();
    expect(first!.text).toBe("hello");
    expect(first!.status).toBe("processing");

    const second = store.claimNextMessage(60_000);
    expect(second).not.toBeNull();
    expect(second!.text).toBe("world");
  });

  it("deduplicates by message_uid (UNIQUE constraint)", () => {
    store.insertInboxMessage({ messageUid: "msg:1", peerId: "user-a", rawJson: "{}", text: "first" });
    const duplicate = store.insertInboxMessage({ messageUid: "msg:1", peerId: "user-a", rawJson: "{}", text: "first" });
    expect(duplicate).toBe(false);
  });

  it("sets processing lease and recovers expired leases", () => {
    store.insertInboxMessage({ messageUid: "msg:1", peerId: "user-a", rawJson: "{}", text: "noop" });
    store.insertInboxMessage({ messageUid: "msg:2", peerId: "user-a", rawJson: "{}", text: "recover-me" });

    // Claim both
    const m1 = store.claimNextMessage(60_000);
    expect(m1).not.toBeNull();
    store.completeMessage(m1!.id);

    const m2 = store.claimNextMessage(60_000);
    expect(m2).not.toBeNull();
    expect(m2!.text).toBe("recover-me");

    // Set the claimed message's lease to expired
    const msgId = m2!.id;
    store.exec(`UPDATE inbox_messages SET status = 'processing', lease_until = 1 WHERE id = ${msgId}`);

    // Recover — should find and mark the expired lease message
    const recovered = store.recoverStuckMessages(300_000);
    expect(recovered).toBe(1);

    // Now claim should bring back the message that was marked 'failed' by recovery
    const reClaimed = store.claimNextMessage(60_000);
    expect(reClaimed).not.toBeNull();
    expect(reClaimed!.text).toBe("recover-me");
    expect(reClaimed!.attempts).toBeGreaterThanOrEqual(2);
  });

  it("marks messages complete", () => {
    store.insertInboxMessage({ messageUid: "msg:1", peerId: "user-a", rawJson: "{}", text: "done" });
    const msg = store.claimNextMessage(60_000);
    expect(msg).not.toBeNull();

    store.completeMessage(msg!.id);

    const pending = store.countPending();
    expect(pending).toBe(0);
  });

  it("marks messages as failed/dead after max attempts", () => {
    store.insertInboxMessage({ messageUid: "msg:1", peerId: "user-a", rawJson: "{}", text: "fail" });
    const msg1 = store.claimNextMessage(60_000);
    expect(msg1).not.toBeNull();
    store.failMessage(msg1!.id, "test error", 1);

    const recent = store.listRecentMessages(10);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.status).toBe("dead");
    expect(recent[0]?.last_error).toContain("test error");
  });

  // ---- Cursor persistence ----

  it("persists and retrieves sync cursor (get_updates_buf)", () => {
    store.saveSyncBuf("account-1", "cursor-value-123");
    expect(store.loadSyncBuf("account-1")).toBe("cursor-value-123");
  });

  // ---- Failed tasks ----

  it("stores and retrieves failed tasks per session", () => {
    store.saveFailedTask({
      id: "fail-1", sessionKey: "weixin_session_a", peerId: "user-a",
      prompt: "do something", error: "codex error",
    });

    const tasks = store.listFailedTasks("weixin_session_a");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.prompt).toBe("do something");
    expect(tasks[0]?.error).toBe("codex error");
  });

  it("does not show failed tasks from other sessions", () => {
    store.saveFailedTask({
      id: "fail-1", sessionKey: "session-a", peerId: "user-a",
      prompt: "a", error: "err",
    });

    const tasks = store.listFailedTasks("session-b");
    expect(tasks).toHaveLength(0);
  });

  it("takeFailedTaskById removes and returns the task", () => {
    store.saveFailedTask({
      id: "take-me", sessionKey: "s1", peerId: "u1",
      prompt: "test", error: "err",
    });

    const task = store.takeFailedTaskById("s1", "take-me");
    expect(task).not.toBeUndefined();
    expect(task!.prompt).toBe("test");

    const remaining = store.listFailedTasks("s1");
    expect(remaining).toHaveLength(0);
  });

  it("clearFailedTasks removes all tasks for a session", () => {
    store.saveFailedTask({
      id: "a", sessionKey: "session-x", peerId: "u1",
      prompt: "a", error: "e",
    });
    store.saveFailedTask({
      id: "b", sessionKey: "session-x", peerId: "u1",
      prompt: "b", error: "e",
    });

    expect(store.clearFailedTasks("session-x")).toBe(2);
    expect(store.listFailedTasks("session-x")).toHaveLength(0);
  });

  it("countFailedTasks returns per-session count", () => {
    store.saveFailedTask({
      id: "a", sessionKey: "s1", peerId: "u1",
      prompt: "a", error: "e",
    });
    store.saveFailedTask({
      id: "b", sessionKey: "s1", peerId: "u1",
      prompt: "b", error: "e",
    });

    expect(store.countFailedTasks("s1")).toBe(2);
  });

  // ---- Session bindings ----

  it("saves and loads session bindings", () => {
    store.saveSessionBinding("bind-1", "user-a", "session-abc");
    expect(store.loadSessionBinding("bind-1")).toBe("session-abc");
  });

  it("returns undefined for unbound session", () => {
    expect(store.loadSessionBinding("nonexistent")).toBeUndefined();
  });

  // ---- Concurrent-like behavior ----

  it("handles transactional metadata updates", () => {
    store.setMeta("tx-test", JSON.stringify({ count: 1, items: ["a", "b"] }));
    const val = store.getMeta("tx-test");
    expect(val).toBe(JSON.stringify({ count: 1, items: ["a", "b"] }));
  });

  it("closed store throws on access", () => {
    store.close();
    expect(() => store.countPending()).toThrow();
  });
});
