import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LeaseManager, DEFAULT_LEASE_MS, HEARTBEAT_INTERVAL_MS } from "../src/leaseManager.js";
import { runMigrations } from "../src/sqliteMigrations.js";

const tempRoots: string[] = [];

function createDb(): { dbPath: string; db: DatabaseSync } {
  const root = mkdtempSync(path.join(os.tmpdir(), "lease-"));
  tempRoots.push(root);
  const dbPath = path.join(root, "test.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db);
  return { dbPath, db };
}

describe("LeaseManager", () => {
  let db: DatabaseSync;
  let manager: LeaseManager;

  beforeEach(() => {
    const created = createDb();
    db = created.db;
    manager = new LeaseManager(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    for (const r of tempRoots.splice(0)) {
      rmSync(r, { force: true, recursive: true });
    }
  });

  // ---- Claim ----

  it("claims next pending message", () => {
    db.prepare(`
      INSERT INTO inbox_messages (account_key, message_uid, peer_id, text, raw_json, created_at)
      VALUES ('acc', 'msg:1', 'peer', 'hello', '{}', 100)
    `).run();

    const claim = manager.claimNext("acc");
    expect(claim).not.toBeNull();
    expect(claim!.text).toBe("hello");
    expect(claim!.leaseToken).toBeTruthy();
    expect(claim!.leaseUntil).toBeGreaterThan(Date.now());
  });

  it("returns null when no messages available", () => {
    const claim = manager.claimNext("acc");
    expect(claim).toBeNull();
  });

  it("does not claim messages from another account", () => {
    db.prepare(`
      INSERT INTO inbox_messages (account_key, message_uid, peer_id, text, raw_json, created_at)
      VALUES ('acc-b', 'msg:1', 'peer', 'for-b', '{}', 100)
    `).run();

    const claim = manager.claimNext("acc-a");
    expect(claim).toBeNull();
  });

  it("increments attempts on claim", () => {
    db.prepare(`
      INSERT INTO inbox_messages (account_key, message_uid, peer_id, text, raw_json, created_at)
      VALUES ('acc', 'msg:1', 'peer', 'test', '{}', 100)
    `).run();

    const claim = manager.claimNext("acc");
    expect(claim).not.toBeNull();
    expect(claim!.attempts).toBe(1);
  });

  // ---- Lease renewal ----

  it("renews lease when token matches", () => {
    db.prepare(`
      INSERT INTO inbox_messages (account_key, message_uid, peer_id, text, raw_json, created_at)
      VALUES ('acc', 'msg:1', 'peer', 'test', '{}', 100)
    `).run();

    const claim = manager.claimNext("acc");
    expect(claim).not.toBeNull();

    const renewed = manager.renewLease({ id: claim!.id, leaseToken: claim!.leaseToken });
    expect(renewed).toBe(true);
  });

  it("does not renew lease with wrong token", () => {
    db.prepare(`
      INSERT INTO inbox_messages (account_key, message_uid, peer_id, text, raw_json, created_at)
      VALUES ('acc', 'msg:1', 'peer', 'test', '{}', 100)
    `).run();

    const claim = manager.claimNext("acc");
    expect(claim).not.toBeNull();

    const renewed = manager.renewLease({ id: claim!.id, leaseToken: "wrong-token" });
    expect(renewed).toBe(false);
  });

  it("does not renew completed message lease", () => {
    db.prepare(`
      INSERT INTO inbox_messages (account_key, message_uid, peer_id, text, raw_json, created_at)
      VALUES ('acc', 'msg:1', 'peer', 'test', '{}', 100)
    `).run();

    const claim = manager.claimNext("acc");
    expect(claim).not.toBeNull();

    manager.completeMessage({ id: claim!.id, leaseToken: claim!.leaseToken });
    const renewed = manager.renewLease({ id: claim!.id, leaseToken: claim!.leaseToken });
    expect(renewed).toBe(false);
  });

  // ---- Complete ----

  it("completes message with correct token", () => {
    db.prepare(`
      INSERT INTO inbox_messages (account_key, message_uid, peer_id, text, raw_json, created_at)
      VALUES ('acc', 'msg:1', 'peer', 'complete-me', '{"secret":"data"}', 100)
    `).run();

    const claim = manager.claimNext("acc");
    expect(claim).not.toBeNull();

    const completed = manager.completeMessage({ id: claim!.id, leaseToken: claim!.leaseToken });
    expect(completed).toBe(true);

    // Verify scrubbing: raw_json and text set to empty
    const row = db.prepare("SELECT status, raw_json, text FROM inbox_messages WHERE id = ?").get(claim!.id) as Record<string, unknown>;
    expect(row.status).toBe("completed");
    expect(row.raw_json).toBe("");
    expect(row.text).toBe("");
  });

  it("does not complete with wrong token", () => {
    db.prepare(`
      INSERT INTO inbox_messages (account_key, message_uid, peer_id, text, raw_json, created_at)
      VALUES ('acc', 'msg:1', 'peer', 'test', '{}', 100)
    `).run();

    const claim = manager.claimNext("acc");
    expect(claim).not.toBeNull();

    const completed = manager.completeMessage({ id: claim!.id, leaseToken: "wrong" });
    expect(completed).toBe(false);
  });

  // ---- Fail ----

  it("fails message with correct token", () => {
    db.prepare(`
      INSERT INTO inbox_messages (account_key, message_uid, peer_id, text, raw_json, created_at)
      VALUES ('acc', 'msg:1', 'peer', 'fail-me', '{}', 100)
    `).run();

    const claim = manager.claimNext("acc");
    expect(claim).not.toBeNull();

    const failed = manager.failMessage({ id: claim!.id, leaseToken: claim!.leaseToken, error: "test error" });
    expect(failed).toBe(true);

    const row = db.prepare("SELECT status, last_error FROM inbox_messages WHERE id = ?").get(claim!.id) as Record<string, unknown>;
    expect(row.status).toBe("failed");
    expect(row.last_error).toContain("test error");
  });

  it("promotes to dead after max attempts", () => {
    db.prepare(`
      INSERT INTO inbox_messages (account_key, message_uid, peer_id, text, raw_json, created_at)
      VALUES ('acc', 'msg:1', 'peer', 'dead', '{}', 100)
    `).run();

    // Claim, then fail with maxAttempts=1 -> should go to dead
    const claim = manager.claimNext("acc");
    expect(claim).not.toBeNull();
    expect(claim!.attempts).toBe(1);

    manager.failMessage({ id: claim!.id, leaseToken: claim!.leaseToken, error: "fatal", maxAttempts: 1 });

    const row = db.prepare("SELECT status, attempts FROM inbox_messages WHERE id = ?").get(claim!.id) as Record<string, unknown>;
    expect(row.status).toBe("dead");
  });

  it("does not fail with wrong token", () => {
    db.prepare(`
      INSERT INTO inbox_messages (account_key, message_uid, peer_id, text, raw_json, created_at)
      VALUES ('acc', 'msg:1', 'peer', 'test', '{}', 100)
    `).run();

    const claim = manager.claimNext("acc");
    expect(claim).not.toBeNull();

    const failed = manager.failMessage({ id: claim!.id, leaseToken: "wrong", error: "test" });
    expect(failed).toBe(false);
  });

  // ---- Skip ----

  it("skips message and scrubs payload", () => {
    db.prepare(`
      INSERT INTO inbox_messages (account_key, message_uid, peer_id, text, raw_json, created_at)
      VALUES ('acc', 'msg:1', 'peer', 'skip-content', '{"secret":true}', 100)
    `).run();

    const rows = db.prepare("SELECT id FROM inbox_messages WHERE message_uid = ?").get("msg:1") as Record<string, unknown>;
    const skipped = manager.skipMessage({ id: Number(rows.id) });
    expect(skipped).toBe(true);

    const row = db.prepare("SELECT status, raw_json, text FROM inbox_messages WHERE id = ?").get(Number(rows.id)) as Record<string, unknown>;
    expect(row.status).toBe("skipped");
    expect(row.raw_json).toBe("");
    expect(row.text).toBe("");
  });

  // ---- Reject ----

  it("rejects message and scrubs payload", () => {
    db.prepare(`
      INSERT INTO inbox_messages (account_key, message_uid, peer_id, text, raw_json, created_at)
      VALUES ('acc', 'msg:1', 'peer', 'reject', '{"secret":true}', 100)
    `).run();

    const rows = db.prepare("SELECT id FROM inbox_messages WHERE message_uid = ?").get("msg:1") as Record<string, unknown>;
    const rejected = manager.rejectMessage({ id: Number(rows.id), reason: "unauthorized" });
    expect(rejected).toBe(true);

    const row = db.prepare("SELECT status, raw_json, text, last_error FROM inbox_messages WHERE id = ?").get(Number(rows.id)) as Record<string, unknown>;
    expect(row.status).toBe("rejected");
    expect(row.raw_json).toBe("");
    expect(row.text).toBe("");
    expect(row.last_error).toBe("unauthorized");
  });

  // ---- Recovery ----

  it("recoverExpiredLeases recovers expired processing messages", () => {
    db.prepare(`
      INSERT INTO inbox_messages (account_key, message_uid, peer_id, text, status, lease_until, created_at)
      VALUES ('acc', 'msg:1', 'peer', 'stuck', 'processing', 1, 100)
    `).run();

    const recovered = manager.recoverExpiredLeases("acc");
    expect(recovered).toBe(1);

    const row = db.prepare("SELECT status, last_error FROM inbox_messages WHERE message_uid = 'msg:1'").get() as Record<string, unknown>;
    expect(row.status).toBe("failed");
    expect(row.last_error).toContain("recovered after crash");
  });

  it("does not recover messages with valid lease", () => {
    const future = Date.now() + 60000;
    db.prepare(`
      INSERT INTO inbox_messages (account_key, message_uid, peer_id, text, status, lease_until, created_at)
      VALUES ('acc', 'msg:1', 'peer', 'active', 'processing', ${future}, 100)
    `).run();

    const recovered = manager.recoverExpiredLeases("acc");
    expect(recovered).toBe(0);
  });

  it("does not recover messages with no lease_until", () => {
    db.prepare(`
      INSERT INTO inbox_messages (account_key, message_uid, peer_id, text, status, lease_until, created_at)
      VALUES ('acc', 'msg:1', 'peer', 'nolease', 'processing', NULL, 100)
    `).run();

    const recovered = manager.recoverExpiredLeases("acc");
    expect(recovered).toBe(0);
  });

  it("only recovers for matching account", () => {
    db.prepare(`
      INSERT INTO inbox_messages (account_key, message_uid, peer_id, text, status, lease_until, created_at)
      VALUES ('acc-a', 'msg:1', 'peer', 'stuck', 'processing', 1, 100)
    `).run();

    const recovered = manager.recoverExpiredLeases("acc-b");
    expect(recovered).toBe(0);
  });

  // ---- Lease state ----

  it("getLeaseState returns correct state", () => {
    db.prepare(`
      INSERT INTO inbox_messages (account_key, message_uid, peer_id, text, raw_json, created_at)
      VALUES ('acc', 'msg:1', 'peer', 'test', '{}', 100)
    `).run();

    const claim = manager.claimNext("acc");
    expect(claim).not.toBeNull();

    const state = manager.getLeaseState(claim!.id);
    expect(state).not.toBeNull();
    expect(state!.leaseToken).toBe(claim!.leaseToken);
    expect(state!.status).toBe("processing");

    manager.completeMessage({ id: claim!.id, leaseToken: claim!.leaseToken });
    const afterState = manager.getLeaseState(claim!.id);
    expect(afterState!.status).toBe("completed");
    expect(afterState!.leaseToken).toBeNull();
  });
});
