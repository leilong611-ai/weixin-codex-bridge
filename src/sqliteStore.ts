/**
 * SQLite-backed durable store for Weixin Codex Bridge.
 *
 * Uses built-in node:sqlite (Node 22+) with WAL mode for crash-safe,
 * concurrent-access message persistence.
 *
 * Key invariants:
 *   1. Inbox write succeeds BEFORE cursor is saved (message safety).
 *   2. Message IDs are unique — duplicate fetch does not duplicate Codex runs.
 *   3. Processing tasks have leases with timeout for crash recovery.
 *   4. All non-query writes use transactions.
 */

import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import type { BridgeConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StoredMessage {
  id: number;
  message_uid: string;
  peer_id: string;
  raw_json: string;
  text: string;
  status: "pending" | "processing" | "completed" | "failed" | "dead";
  created_at: number;
  lease_until: number | null;
  attempts: number;
  last_error: string | null;
}

export interface FailedTaskRow {
  id: string;
  session_key: string;
  peer_id: string;
  prompt: string;
  error: string;
  message_uid: string | null;
  run_directory: string | null;
  created_at: number;
}

// ---------------------------------------------------------------------------
// SQLite Store
// ---------------------------------------------------------------------------

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS inbox_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  message_uid     TEXT    NOT NULL UNIQUE,
  peer_id         TEXT    NOT NULL,
  raw_json        TEXT    NOT NULL DEFAULT '',
  text            TEXT    NOT NULL DEFAULT '',
  status          TEXT    NOT NULL DEFAULT 'pending'
                      CHECK(status IN ('pending','processing','completed','failed','dead')),
  created_at      INTEGER NOT NULL,
  lease_until     INTEGER,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT
);

CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox_messages(status);
CREATE INDEX IF NOT EXISTS idx_inbox_uid   ON inbox_messages(message_uid);

CREATE TABLE IF NOT EXISTS runtime_metadata (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS failed_tasks (
  id            TEXT PRIMARY KEY,
  session_key   TEXT NOT NULL,
  peer_id       TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  error         TEXT NOT NULL,
  message_uid   TEXT,
  run_directory TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_failed_session ON failed_tasks(session_key);
`;

export class SqliteStore {
  private db: DatabaseSync;
  readonly dbPath: string;

  constructor(config: BridgeConfig) {
    const dbDir = path.join(config.logRoot, "sqlite");
    mkdirSync(dbDir, { recursive: true });
    this.dbPath = path.join(dbDir, "bridge.db");
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(SCHEMA);
  }

  close(): void {
    try { this.db.close(); } catch { /* idempotent */ }
  }

  // ---- Metadata ---------------------------------------------------------

  getMeta(key: string): string | undefined {
    const row = this.db.prepare(
      "SELECT value FROM runtime_metadata WHERE key = ?"
    ).get(key) as Record<string, string> | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare(
      `INSERT INTO runtime_metadata (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value);
  }

  // ---- Durable inbox ----------------------------------------------------

  insertInboxMessage(params: {
    messageUid: string;
    peerId: string;
    rawJson: string;
    text: string;
    createTimeMs?: number;
  }): boolean {
    try {
      this.db.prepare(`
        INSERT INTO inbox_messages (message_uid, peer_id, raw_json, text, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        params.messageUid,
        params.peerId,
        params.rawJson,
        params.text,
        params.createTimeMs ?? Date.now(),
      );
      return true;
    } catch {
      return false; // UNIQUE violation = duplicate
    }
  }

  claimNextMessage(leaseMs: number): StoredMessage | null {
    this.db.exec("BEGIN");
    try {
      const row = this.db.prepare(`
        SELECT id, message_uid, peer_id, raw_json, text, status,
               created_at, lease_until, attempts, last_error
        FROM inbox_messages
        WHERE status IN ('pending', 'failed')
           OR (status = 'processing' AND lease_until IS NOT NULL AND lease_until < ?)
        ORDER BY id ASC
        LIMIT 1
      `).get(Date.now()) as Record<string, unknown> | undefined;

      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }

      this.db.prepare(`
        UPDATE inbox_messages
        SET status = 'processing', lease_until = ?, attempts = attempts + 1
        WHERE id = ?
      `).run(Date.now() + leaseMs, Number(row.id));

      this.db.exec("COMMIT");

      // Re-read to get updated attempts value
      const updated = this.db.prepare(`
        SELECT id, message_uid, peer_id, raw_json, text, status,
               created_at, lease_until, attempts, last_error
        FROM inbox_messages WHERE id = ?
      `).get(Number(row.id)) as Record<string, unknown> | undefined;

      return updated ? rowToMsg(updated) : rowToMsg(row, "processing", Date.now() + leaseMs);
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  completeMessage(id: number): void {
    this.db.prepare(`
      UPDATE inbox_messages SET status = 'completed', lease_until = NULL, last_error = NULL
      WHERE id = ?
    `).run(id);
  }

  failMessage(id: number, error: string, maxAttempts = 3): void {
    const row = this.db.prepare(
      "SELECT attempts FROM inbox_messages WHERE id = ?"
    ).get(id) as Record<string, unknown> | undefined;
    const attempts = Number(row?.attempts ?? 0);
    const ns = attempts >= maxAttempts ? "dead" : "failed";
    this.db.prepare(`
      UPDATE inbox_messages SET status = ?, lease_until = NULL, last_error = ? WHERE id = ?
    `).run(ns, error.slice(0, 2000), id);
  }

  countPending(): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM inbox_messages WHERE status IN ('pending','failed')"
    ).get() as Record<string, number>;
    return Number(row.cnt);
  }

  listRecentMessages(limit = 20): StoredMessage[] {
    const rows = this.db.prepare(`
      SELECT id, message_uid, peer_id, raw_json, text, status,
             created_at, lease_until, attempts, last_error
      FROM inbox_messages ORDER BY id DESC LIMIT ?
    `).all(limit) as Record<string, unknown>[];
    return rows.map((r) => rowToMsg(r));
  }

  // ---- Cursor persistence -----------------------------------------------

  loadSyncBuf(accountId: string): string {
    return this.getMeta(`cursor:${accountId}`) ?? "";
  }

  saveSyncBuf(accountId: string, buf: string): void {
    this.setMeta(`cursor:${accountId}`, buf);
  }

  // ---- Failed tasks -----------------------------------------------------

  saveFailedTask(params: {
    id: string; sessionKey: string; peerId: string; prompt: string;
    error: string; messageUid?: string; runDirectory?: string;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO failed_tasks
      (id, session_key, peer_id, prompt, error, message_uid, run_directory, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.id, params.sessionKey, params.peerId, params.prompt,
      params.error.slice(0, 2000),
      params.messageUid ?? null, params.runDirectory ?? null, Date.now(),
    );
  }

  listFailedTasks(sessionKey: string): Array<{
    id: string; prompt: string; error: string; peerId: string;
    messageUid?: string; createdAt: number;
  }> {
    const rows = this.db.prepare(`
      SELECT id, prompt, error, peer_id, message_uid, created_at
      FROM failed_tasks WHERE session_key = ? ORDER BY created_at DESC
    `).all(sessionKey) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id ?? ""),
      prompt: String(r.prompt ?? ""),
      error: String(r.error ?? ""),
      peerId: String(r.peer_id ?? ""),
      messageUid: r.message_uid != null && String(r.message_uid) !== "" ? String(r.message_uid) : undefined,
      createdAt: Number(r.created_at),
    }));
  }

  takeFailedTaskById(sessionKey: string, id: string): {
    id: string; prompt: string; error: string; peerId: string; messageUid?: string;
  } | undefined {
    this.db.exec("BEGIN");
    try {
      const row = this.db.prepare(
        "SELECT id, prompt, error, peer_id, message_uid FROM failed_tasks WHERE session_key = ? AND id = ?"
      ).get(sessionKey, id) as Record<string, unknown> | undefined;
      if (!row) { this.db.exec("COMMIT"); return undefined; }
      this.db.prepare("DELETE FROM failed_tasks WHERE session_key = ? AND id = ?").run(sessionKey, id);
      this.db.exec("COMMIT");
      return {
        id: String(row.id), prompt: String(row.prompt), error: String(row.error),
        peerId: String(row.peer_id),
        messageUid: row.message_uid ? String(row.message_uid) : undefined,
      };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  clearFailedTasks(sessionKey: string): number {
    return Number(
      this.db.prepare("DELETE FROM failed_tasks WHERE session_key = ?").run(sessionKey).changes
    );
  }

  countFailedTasks(sessionKey?: string): number {
    if (sessionKey) {
      const r = this.db.prepare(
        "SELECT COUNT(*) as cnt FROM failed_tasks WHERE session_key = ?"
      ).get(sessionKey) as Record<string, number>;
      return Number(r.cnt);
    }
    const r = this.db.prepare("SELECT COUNT(*) as cnt FROM failed_tasks").get() as Record<string, number>;
    return Number(r.cnt);
  }

  // ---- Session bindings -------------------------------------------------

  saveSessionBinding(sessionKey: string, peerId: string, codexSessionId: string | null): void {
    this.setMeta(`bind:${sessionKey}`, codexSessionId ?? "");
  }

  loadSessionBinding(sessionKey: string): string | undefined {
    const v = this.getMeta(`bind:${sessionKey}`);
    return v === "" ? undefined : v;
  }

  // ---- Crash recovery ---------------------------------------------------

  recoverStuckMessages(leaseMs: number): number {
    return Number(this.db.prepare(`
      UPDATE inbox_messages
      SET status = 'failed', lease_until = NULL,
          last_error = 'recovered after crash (lease expired)'
      WHERE status = 'processing' AND lease_until IS NOT NULL AND lease_until < ?
    `).run(Date.now() - leaseMs).changes);
  }

  // ---- Raw exec for tests -----------------------------------------------

  exec(sql: string): void {
    this.db.exec(sql);
  }
}

// ---- Helpers -------------------------------------------------------------

function rowToMsg(
  row: Record<string, unknown>,
  statusOverride?: string,
  leaseOverride?: number,
): StoredMessage {
  return {
    id: Number(row.id),
    message_uid: String(row.message_uid ?? ""),
    peer_id: String(row.peer_id ?? ""),
    raw_json: String(row.raw_json ?? ""),
    text: String(row.text ?? ""),
    status: (statusOverride ?? String(row.status ?? "")) as StoredMessage["status"],
    created_at: Number(row.created_at),
    lease_until: leaseOverride ?? (row.lease_until != null ? Number(row.lease_until) : null),
    attempts: Number(row.attempts),
    last_error: row.last_error != null ? String(row.last_error) : null,
  };
}
