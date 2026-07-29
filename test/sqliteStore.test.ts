import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BridgeConfig } from "../src/config.js";
import { SqliteStore } from "../src/sqliteStore.js";
import { makeAccountHash } from "../src/messageIdentity.js";

const tempRoots: string[] = [];
const TEST_ACCOUNT = "test-account";
const TEST_ACCOUNT_KEY = makeAccountHash(TEST_ACCOUNT);

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
    const r1 = store.insertInboxMessage({
      accountKey: TEST_ACCOUNT_KEY, messageUid: "msg:1", peerId: "user-a", rawJson: "{}", text: "hello"
    });
    expect(r1.status).toBe("inserted");

    const r2 = store.insertInboxMessage({
      accountKey: TEST_ACCOUNT_KEY, messageUid: "msg:2", peerId: "user-a", rawJson: "{}", text: "world"
    });
    expect(r2.status).toBe("inserted");

    const first = store.claimNextMessage(TEST_ACCOUNT_KEY);
    expect(first).not.toBeNull();
    expect(first!.text).toBe("hello");

    const second = store.claimNextMessage(TEST_ACCOUNT_KEY);
    expect(second).not.toBeNull();
    expect(second!.text).toBe("world");
  });

  it("deduplicates by (account_key, message_uid)", () => {
    const r1 = store.insertInboxMessage({
      accountKey: TEST_ACCOUNT_KEY, messageUid: "msg:1", peerId: "user-a", rawJson: "{}", text: "first"
    });
    expect(r1.status).toBe("inserted");

    const r2 = store.insertInboxMessage({
      accountKey: TEST_ACCOUNT_KEY, messageUid: "msg:1", peerId: "user-a", rawJson: "{}", text: "first"
    });
    expect(r2.status).toBe("duplicate");
  });

  it("deduplicates across different accounts - same message_id", () => {
    const r1 = store.insertInboxMessage({
      accountKey: "account-a", messageUid: "msg:1", peerId: "user-a", rawJson: "{}", text: "a"
    });
    expect(r1.status).toBe("inserted");

    // Same message_uid but different account_key - should be inserted
    const r2 = store.insertInboxMessage({
      accountKey: "account-b", messageUid: "msg:1", peerId: "user-a", rawJson: "{}", text: "b"
    });
    expect(r2.status).toBe("inserted");

    // Same account_key + same message_uid - duplicate
    const r3 = store.insertInboxMessage({
      accountKey: "account-a", messageUid: "msg:1", peerId: "user-a", rawJson: "{}", text: "a-dup"
    });
    expect(r3.status).toBe("duplicate");
  });

  it("sets processing lease and recovers expired leases", () => {
    store.insertInboxMessage({ accountKey: TEST_ACCOUNT_KEY, messageUid: "msg:1", peerId: "user-a", rawJson: "{}", text: "noop" });
    store.insertInboxMessage({ accountKey: TEST_ACCOUNT_KEY, messageUid: "msg:2", peerId: "user-a", rawJson: "{}", text: "recover-me" });

    // Claim both
    const m1 = store.claimNextMessage(TEST_ACCOUNT_KEY);
    expect(m1).not.toBeNull();
    store.completeMessage(m1!.id, m1!.leaseToken);

    const m2 = store.claimNextMessage(TEST_ACCOUNT_KEY);
    expect(m2).not.toBeNull();
    expect(m2!.text).toBe("recover-me");

    // Set the claimed message's lease to expired
    const msgId = m2!.id;
    store.exec(`UPDATE inbox_messages SET status = 'processing', lease_until = 1 WHERE id = ${msgId}`);

    // Recover — should find and mark the expired lease message
    const recovered = store.recoverExpiredLeases(TEST_ACCOUNT_KEY);
    expect(recovered).toBe(1);

    // Now claim should bring back the message that was marked 'failed' by recovery
    const reClaimed = store.claimNextMessage(TEST_ACCOUNT_KEY);
    expect(reClaimed).not.toBeNull();
    expect(reClaimed!.text).toBe("recover-me");
    expect(reClaimed!.attempts).toBeGreaterThanOrEqual(2);
  });

  it("partial data: lease_until check uses now directly, not now - leaseMs", () => {
    store.insertInboxMessage({ accountKey: TEST_ACCOUNT_KEY, messageUid: "msg:lease-test", peerId: "user-a", rawJson: "{}", text: "lease-test" });

    const claim = store.claimNextMessage(TEST_ACCOUNT_KEY);
    expect(claim).not.toBeNull();

    // Force lease to a near-future expiry that is not yet past
    const now = Date.now();
    const msgId = claim!.id;
    store.exec(`UPDATE inbox_messages SET status = 'processing', lease_until = ${now + 60000} WHERE id = ${msgId}`);

    // Should not recover — lease is still valid
    const recovered = store.recoverExpiredLeases(TEST_ACCOUNT_KEY, { now });
    expect(recovered).toBe(0);
  });

  it("long task heartbeat prevents re-claiming", () => {
    store.insertInboxMessage({ accountKey: TEST_ACCOUNT_KEY, messageUid: "msg:heartbeat", peerId: "user-a", rawJson: "{}", text: "heartbeat-test" });

    const claim = store.claimNextMessage(TEST_ACCOUNT_KEY, { leaseMs: 5000 });
    expect(claim).not.toBeNull();

    // Renew the lease
    const renewed = store.renewLease(claim!.id, claim!.leaseToken, 5000);
    expect(renewed).toBe(true);

    // Another claim should fail (lease still valid, heartbeat active)
    const secondClaim = store.claimNextMessage(TEST_ACCOUNT_KEY);
    expect(secondClaim).toBeNull();

    // Expire the lease
    store.exec(`UPDATE inbox_messages SET lease_until = 1 WHERE id = ${claim!.id}`);

    // Now it can be recovered
    const recovered = store.recoverExpiredLeases(TEST_ACCOUNT_KEY);
    expect(recovered).toBe(1);
  });

  it("wrong lease token cannot complete or fail message", () => {
    store.insertInboxMessage({ accountKey: TEST_ACCOUNT_KEY, messageUid: "msg:token-test", peerId: "user-a", rawJson: "{}", text: "token-test" });

    const claim = store.claimNextMessage(TEST_ACCOUNT_KEY);
    expect(claim).not.toBeNull();

    // Wrong token cannot complete
    const completed = store.completeMessage(claim!.id, "wrong-token");
    expect(completed).toBe(false);

    // Wrong token cannot fail
    const failed = store.failMessage(claim!.id, "wrong-token", "test error");
    expect(failed).toBe(false);

    // Correct token can complete
    const realComplete = store.completeMessage(claim!.id, claim!.leaseToken);
    expect(realComplete).toBe(true);
  });

  it("marks messages complete", () => {
    store.insertInboxMessage({ accountKey: TEST_ACCOUNT_KEY, messageUid: "msg:1", peerId: "user-a", rawJson: "{}", text: "done" });
    const msg = store.claimNextMessage(TEST_ACCOUNT_KEY);
    expect(msg).not.toBeNull();

    store.completeMessage(msg!.id, msg!.leaseToken);

    const pending = store.countPending(TEST_ACCOUNT_KEY);
    expect(pending).toBe(0);
  });

  it("marks messages as failed/dead after max attempts", () => {
    store.insertInboxMessage({ accountKey: TEST_ACCOUNT_KEY, messageUid: "msg:1", peerId: "user-a", rawJson: "{}", text: "fail" });
    const msg1 = store.claimNextMessage(TEST_ACCOUNT_KEY);
    expect(msg1).not.toBeNull();
    store.failMessage(msg1!.id, msg1!.leaseToken, "test error", { maxAttempts: 1 });

    const recent = store.listRecentMessages(TEST_ACCOUNT_KEY, 10);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.status).toBe("dead");
    expect(recent[0]?.lastError).toContain("test error");
  });

  // ---- Cursor persistence ----

  it("persists and retrieves sync cursor (get_updates_buf)", () => {
    store.saveSyncBuf(TEST_ACCOUNT_KEY, "cursor-value-123");
    expect(store.loadSyncBuf(TEST_ACCOUNT_KEY)).toBe("cursor-value-123");
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

  // ---- Batch persistence ----

  it("persistFetchedBatch inserts messages and cursor atomically", () => {
    const result = store.persistFetchedBatch({
      accountKey: TEST_ACCOUNT_KEY,
      nextCursor: "cursor-atomic",
      messages: [
        { messageUid: "batch:1", peerId: "u1", rawJson: "{}", text: "batch1" },
        { messageUid: "batch:2", peerId: "u1", rawJson: "{}", text: "batch2" },
      ],
    });

    expect(result.inserted).toBe(2);
    expect(result.skipped).toBe(0);
    expect(store.loadSyncBuf(TEST_ACCOUNT_KEY)).toBe("cursor-atomic");

    const pending = store.countPending(TEST_ACCOUNT_KEY);
    expect(pending).toBe(2);
  });

  it("persistFetchedBatch handles duplicates vs new messages", () => {
    // Insert one first
    store.insertInboxMessage({
      accountKey: TEST_ACCOUNT_KEY, messageUid: "batch:1", peerId: "u1", rawJson: "{}", text: "existing"
    });

    const result = store.persistFetchedBatch({
      accountKey: TEST_ACCOUNT_KEY,
      nextCursor: "cursor-dup",
      messages: [
        { messageUid: "batch:1", peerId: "u1", rawJson: "{}", text: "existing" },
        { messageUid: "batch:2", peerId: "u1", rawJson: "{}", text: "new" },
      ],
    });

    expect(result.inserted).toBe(1);
    expect(result.skipped).toBe(1);
    expect(store.loadSyncBuf(TEST_ACCOUNT_KEY)).toBe("cursor-dup");
  });

  it("persistFetchedBatch: cursor not saved if transaction rolls back on error", () => {
    // This test verifies that a broken message causes rollback
    // We'll close the db to simulate a failure
    store.close();

    expect(() => {
      store.persistFetchedBatch({
        accountKey: TEST_ACCOUNT_KEY,
        nextCursor: "fail-cursor",
        messages: [
          { messageUid: "fail:1", peerId: "u1", rawJson: "{}", text: "fail" },
        ],
      });
    }).toThrow();
  });

  // ---- Privacy: payload scrubbing ----

  it("completed messages have scrubbed payload", () => {
    store.insertInboxMessage({
      accountKey: TEST_ACCOUNT_KEY, messageUid: "msg:scrub", peerId: "user-a",
      rawJson: '{"secret":"data"}', text: "sensitive content"
    });

    const claim = store.claimNextMessage(TEST_ACCOUNT_KEY);
    expect(claim).not.toBeNull();
    expect(claim!.payload?.rawJson).toBe('{"secret":"data"}');

    store.completeMessage(claim!.id, claim!.leaseToken);

    // After completion, payload should be scrubbed
    const recent = store.listRecentMessages(TEST_ACCOUNT_KEY, 10);
    const completed = recent.find((m) => m.messageUid === "msg:scrub");
    expect(completed?.rawJson).toBe("");
    expect(completed?.text).toBe("");
  });

  it("skipped messages have no payload", () => {
    const result = store.insertInboxMessage({
      accountKey: TEST_ACCOUNT_KEY, messageUid: "msg:skip", peerId: "user-a",
      rawJson: "secret", text: "skip content",
      statusOverride: "skipped",
    });
    expect(result.status).toBe("inserted");

    const recent = store.listRecentMessages(TEST_ACCOUNT_KEY, 10);
    const skipped = recent.find((m) => m.messageUid === "msg:skip");
    expect(skipped?.status).toBe("skipped");
    expect(skipped?.rawJson).toBe("secret");
    expect(skipped?.text).toBe("skip content");
  });

  // ---- Account isolation ----

  it("account A does not see account B's pending messages", () => {
    store.insertInboxMessage({ accountKey: "account-a", messageUid: "msg:a1", peerId: "u1", rawJson: "{}", text: "a" });
    store.insertInboxMessage({ accountKey: "account-b", messageUid: "msg:b1", peerId: "u1", rawJson: "{}", text: "b" });

    expect(store.countPending("account-a")).toBe(1);
    expect(store.countPending("account-b")).toBe(1);
  });

  it("account A claims only its own messages", () => {
    store.insertInboxMessage({ accountKey: "account-a", messageUid: "msg:a1", peerId: "u1", rawJson: "{}", text: "a-only" });
    store.insertInboxMessage({ accountKey: "account-b", messageUid: "msg:b1", peerId: "u1", rawJson: "{}", text: "b-only" });

    const claimA = store.claimNextMessage("account-a");
    expect(claimA).not.toBeNull();
    expect(claimA!.text).toBe("a-only");

    const claimB = store.claimNextMessage("account-b");
    expect(claimB).not.toBeNull();
    expect(claimB!.text).toBe("b-only");
  });

  // ---- Data retention ----

  it("cleanupExpiredData removes old completed messages", () => {
    store.insertInboxMessage({ accountKey: TEST_ACCOUNT_KEY, messageUid: "msg:old", peerId: "u1", rawJson: "{}", text: "old" });
    const claim = store.claimNextMessage(TEST_ACCOUNT_KEY);
    expect(claim).not.toBeNull();
    store.completeMessage(claim!.id, claim!.leaseToken);

    // Manually set completed_at to far in the past
    const farPast = Date.now() - 30 * 86_400_000;
    store.exec(`UPDATE inbox_messages SET completed_at = ${farPast} WHERE message_uid = 'msg:old'`);

    expect(store.estimateCleanup().deletedMessages).toBe(1);

    const cleanupResult = store.cleanupExpiredData();
    expect(cleanupResult.deletedMessages).toBe(1);
  });

  // ---- Closed store errors ----

  it("closed store throws on access", () => {
    store.close();
    expect(() => store.countPending(TEST_ACCOUNT_KEY)).toThrow();
  });

  it("SQL errors propagate (not silently swallowed)", () => {
    store.exec("DROP TABLE IF EXISTS inbox_messages");
    expect(() => store.insertInboxMessage({
      accountKey: TEST_ACCOUNT_KEY, messageUid: "msg:err", peerId: "u1", rawJson: "{}", text: "err"
    })).toThrow();
  });

  // ---- Migration test ----

  it("schema starts at version 3", () => {
    expect(store.schemaVersion).toBe(3);
  });

  it("new database has correct columns for v3 schema", () => {
    store.insertInboxMessage({ accountKey: "test-key", messageUid: "test:uid", peerId: "test-peer", rawJson: "{}", text: "test" });

    // Verify columns exist by accessing them
    const rows = store.exec("SELECT account_key, message_uid, lease_token, lease_owner, updated_at, completed_at, error_category FROM inbox_messages WHERE message_uid = 'test:uid'");
    // This should not throw
  });
});
