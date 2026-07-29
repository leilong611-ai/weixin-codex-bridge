import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runMigrations, getSchemaVersion } from "../src/sqliteMigrations.js";

const tempRoots: string[] = [];

describe("sqliteMigrations", () => {
  let dbPath: string;
  let db: DatabaseSync;

  beforeEach(() => {
    const root = mkdtempSync(path.join(os.tmpdir(), "migration-"));
    tempRoots.push(root);
    dbPath = path.join(root, "test.db");
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    for (const r of tempRoots.splice(0)) {
      rmSync(r, { force: true, recursive: true });
    }
  });

  it("migrates from v0 to v3 on fresh database", () => {
    const result = runMigrations(db);
    expect(result.fromVersion).toBe(0);
    expect(result.toVersion).toBe(3);
    expect(result.applied).toEqual([1, 2, 3]);
    expect(getSchemaVersion(db)).toBe(3);
  });

  it("is idempotent — running twice does not re-apply", () => {
    runMigrations(db);
    const result = runMigrations(db);
    expect(result.applied).toEqual([]);
    expect(result.fromVersion).toBe(3);
    expect(result.toVersion).toBe(3);
  });

  it("creates expected v3 tables and columns", () => {
    runMigrations(db);

    // Verify tables exist
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("inbox_messages");
    expect(tableNames).toContain("runtime_metadata");
    expect(tableNames).toContain("failed_tasks");
  });

  it("inbox_messages has correct v3 columns", () => {
    runMigrations(db);

    const columns = db.prepare("PRAGMA table_info(inbox_messages)").all() as Array<{
      name: string;
      notnull: number;
      pk: number;
      type: string;
    }>;
    const colNames = columns.map((c) => c.name);

    // v1 columns
    expect(colNames).toContain("id");
    expect(colNames).toContain("message_uid");
    expect(colNames).toContain("peer_id");
    expect(colNames).toContain("raw_json");
    expect(colNames).toContain("text");
    expect(colNames).toContain("status");
    expect(colNames).toContain("created_at");
    expect(colNames).toContain("lease_until");
    expect(colNames).toContain("attempts");
    expect(colNames).toContain("last_error");

    // v2+ columns
    expect(colNames).toContain("account_key");
    expect(colNames).toContain("lease_token");
    expect(colNames).toContain("lease_owner");
    expect(colNames).toContain("updated_at");
    expect(colNames).toContain("completed_at");

    // v3 columns
    expect(colNames).toContain("error_category");
  });

  it("preserves existing data across migrations", () => {
    // Create v1 schema manually including all v1 tables
    db.exec(`
      CREATE TABLE inbox_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_uid TEXT NOT NULL UNIQUE,
        peer_id TEXT NOT NULL,
        raw_json TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending','processing','completed','failed','dead')),
        created_at INTEGER NOT NULL,
        lease_until INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
      CREATE TABLE runtime_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE failed_tasks (
        id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        error TEXT NOT NULL,
        message_uid TEXT,
        run_directory TEXT,
        created_at INTEGER NOT NULL
      );
      INSERT INTO inbox_messages (message_uid, peer_id, text, created_at)
      VALUES ('old:msg', 'test-peer', 'preserved', 1000);
    `);
    db.prepare("PRAGMA user_version = 1").run();

    // Run all migrations
    runMigrations(db);

    // Data should still exist
    const row = db.prepare("SELECT text FROM inbox_messages WHERE message_uid = ?").get("old:msg") as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row!.text).toBe("preserved");
  });

  it("supports skipped and rejected status values", () => {
    runMigrations(db);

    // Insert with skipped status
    db.prepare(`
      INSERT INTO inbox_messages (account_key, message_uid, peer_id, status, created_at)
      VALUES ('acc', 'skip:msg', 'peer', 'skipped', 100)
    `).run();

    const row = db.prepare("SELECT status FROM inbox_messages WHERE message_uid = ?").get("skip:msg") as Record<string, unknown> | undefined;
    expect(row?.status).toBe("skipped");

    // Insert with rejected status
    db.prepare(`
      INSERT INTO inbox_messages (account_key, message_uid, peer_id, status, created_at)
      VALUES ('acc', 'rej:msg', 'peer', 'rejected', 100)
    `).run();

    const row2 = db.prepare("SELECT status FROM inbox_messages WHERE message_uid = ?").get("rej:msg") as Record<string, unknown> | undefined;
    expect(row2?.status).toBe("rejected");
  });

  it("rolls back on migration failure", () => {
    // Mark version as 1 then drop inbox_messages so v2 ALTER TABLE fails
    db.exec(`
      CREATE TABLE inbox_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_uid TEXT NOT NULL UNIQUE,
        peer_id TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE runtime_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE failed_tasks (
        id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        error TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    db.prepare("PRAGMA user_version = 1").run();

    // Drop inbox_messages so v2 ALTER TABLE fails
    db.exec("DROP TABLE inbox_messages");

    // Migration should throw
    expect(() => runMigrations(db)).toThrow();

    // Version should remain at 1 (rollback)
    expect(getSchemaVersion(db)).toBe(1);
  });
});
