import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DataRetention } from "../src/dataRetention.js";
import { runMigrations } from "../src/sqliteMigrations.js";

const tempRoots: string[] = [];

function createDb(): { dbPath: string; db: DatabaseSync; retention: DataRetention } {
  const root = mkdtempSync(path.join(os.tmpdir(), "retention-"));
  tempRoots.push(root);
  const dbPath = path.join(root, "test.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db);

  const retention = new DataRetention(db, { retentionDays: 7, walCheckpoint: false });
  return { dbPath, db, retention };
}

describe("DataRetention", () => {
  let db: DatabaseSync;
  let retention: DataRetention;
  let dbPath: string;

  beforeEach(() => {
    const created = createDb();
    db = created.db;
    retention = created.retention;
    dbPath = created.dbPath;
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    for (const r of tempRoots.splice(0)) {
      rmSync(r, { force: true, recursive: true });
    }
  });

  it("cleanup does nothing on empty database", () => {
    const result = retention.cleanup();
    expect(result.deletedMessages).toBe(0);
    expect(result.deletedFailedTasks).toBe(0);
  });

  it("deletes old completed messages", () => {
    // Insert and complete a message with old timestamp
    const farPast = Date.now() - 20 * 86_400_000;
    db.prepare(`
      INSERT INTO inbox_messages (account_key, message_uid, peer_id, status, created_at, completed_at)
      VALUES ('acc', 'old:msg', 'peer', 'completed', 100, ${farPast})
    `).run();

    const result = retention.cleanup();
    expect(result.deletedMessages).toBe(1);

    const remaining = db.prepare("SELECT COUNT(*) as cnt FROM inbox_messages WHERE message_uid = 'old:msg'").get() as Record<string, number>;
    expect(Number(remaining.cnt)).toBe(0);
  });

  it("does not delete recent completed messages", () => {
    const recent = Date.now() - 86_400_000; // 1 day ago
    db.prepare(`
      INSERT INTO inbox_messages (account_key, message_uid, peer_id, status, created_at, completed_at)
      VALUES ('acc', 'recent:msg', 'peer', 'completed', 100, ${recent})
    `).run();

    const result = retention.cleanup();
    expect(result.deletedMessages).toBe(0);
  });

  it("deletes skipped, rejected, and dead messages", () => {
    const farPast = Date.now() - 20 * 86_400_000;

    for (const status of ["skipped", "rejected", "dead"]) {
      db.prepare(`
        INSERT INTO inbox_messages (account_key, message_uid, peer_id, status, created_at, completed_at)
        VALUES ('acc', '${status}:msg', 'peer', '${status}', 100, ${farPast})
      `).run();
    }

    const result = retention.cleanup();
    expect(result.deletedMessages).toBe(3);
  });

  it("does not delete pending or processing messages", () => {
    const farPast = Date.now() - 20 * 86_400_000;

    db.prepare(`
      INSERT INTO inbox_messages (account_key, message_uid, peer_id, status, created_at)
      VALUES ('acc', 'pending:msg', 'peer', 'pending', ${farPast})
    `).run();
    db.prepare(`
      INSERT INTO inbox_messages (account_key, message_uid, peer_id, status, lease_until, created_at)
      VALUES ('acc', 'proc:msg', 'peer', 'processing', ${Date.now() + 60000}, ${farPast})
    `).run();

    const result = retention.cleanup();
    expect(result.deletedMessages).toBe(0);
  });

  it("deletes old failed tasks", () => {
    const farPast = Date.now() - 20 * 86_400_000;
    db.prepare(`
      INSERT INTO failed_tasks (id, session_key, peer_id, prompt, error, created_at)
      VALUES ('old-task', 'session', 'peer', 'test', 'error', ${farPast})
    `).run();

    const result = retention.cleanup();
    expect(result.deletedFailedTasks).toBe(1);
  });

  it("estimateCleanup returns count without deleting", () => {
    const farPast = Date.now() - 20 * 86_400_000;
    db.prepare(`
      INSERT INTO inbox_messages (account_key, message_uid, peer_id, status, created_at, completed_at)
      VALUES ('acc', 'old:msg', 'peer', 'completed', 100, ${farPast})
    `).run();

    const estimate = retention.estimateCleanup();
    expect(estimate.deletedMessages).toBe(1);

    // Message should still exist after estimate
    const count = db.prepare("SELECT COUNT(*) as cnt FROM inbox_messages").get() as Record<string, number>;
    expect(Number(count.cnt)).toBe(1);
  });

  it("scrubResidualPayloads clears payload from completed etc", () => {
    db.prepare(`
      INSERT INTO inbox_messages (account_key, message_uid, peer_id, text, raw_json, status, created_at, completed_at)
      VALUES ('acc', 'msg:1', 'peer', 'text-data', '{"json":"data"}', 'completed', 100, 200)
    `).run();

    const scrubbed = retention.scrubResidualPayloads();
    expect(scrubbed).toBe(1);

    const row = db.prepare("SELECT raw_json, text FROM inbox_messages WHERE message_uid = 'msg:1'").get() as Record<string, unknown>;
    expect(row.raw_json).toBe("");
    expect(row.text).toBe("");
  });

  it("getDatabaseInfo returns file sizes", () => {
    const info = retention.getDatabaseInfo(dbPath);
    expect(info.dbBytes).toBeGreaterThan(0);
  });
});
