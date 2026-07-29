/**
 * SQLite-backed durable store for Weixin Codex Bridge.
 *
 * Uses built-in node:sqlite (Node 22+) with WAL mode for crash-safe,
 * concurrent-access message persistence.
 *
 * Key invariants:
 *   1. Inbox write succeeds BEFORE cursor is saved (message safety).
 *   2. Batch writes and cursor updates are atomic within a transaction.
 *   3. Message IDs are scoped per account_key — duplicate fetch does not duplicate runs.
 *   4. Processing tasks have lease tokens for safe state transitions.
 *   5. Completed/skipped/rejected messages have payload scrubbed.
 *   6. SQLite errors are never silently swallowed.
 *
 * @module
 */

import { mkdirSync, chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import type { BridgeConfig } from "./config.js";
import { runMigrations, getSchemaVersion } from "./sqliteMigrations.js";
import { LeaseManager } from "./leaseManager.js";
import { DataRetention, type CleanupResult, type DataRetentionConfig } from "./dataRetention.js";
import type { PayloadToStore, StoredPayload } from "./messagePayload.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InboxInsertResult =
  | { status: "inserted"; id: number }
  | { status: "duplicate" };

export interface PersistBatchResult {
  inserted: number;
  skipped: number;
  /** Whether the cursor was updated */
  cursorUpdated: boolean;
}

export interface PersistBatchParams {
  accountKey: string;
  nextCursor: string;
  messages: PersistableInboxMessage[];
}

export interface PersistableInboxMessage {
  messageUid: string;
  peerId: string;
  peerHash: string;
  rawJson: string;
  text: string;
  payloadJson: string;
  payloadVersion: number | null;
  createTimeMs?: number;
  statusOverride?: "pending" | "skipped" | "rejected";
}

export interface StoredMessage {
  id: number;
  messageUid: string;
  accountKey: string;
  peerId: string;
  rawJson: string;
  text: string;
  status: "pending" | "processing" | "completed" | "failed" | "dead" | "skipped" | "rejected";
  createdAt: number;
  leaseUntil: number | null;
  leaseToken: string | null;
  attempts: number;
  lastError: string | null;
  errorCategory: string | null;
  completedAt: number | null;
}

export interface FailedTaskRow {
  id: string;
  sessionKey: string;
  peerId: string;
  prompt: string;
  error: string;
  messageUid: string | null;
  runDirectory: string | null;
  createdAt: number;
  reasonCode: string | null;
}

// ---------------------------------------------------------------------------
// SQLite Store
// ---------------------------------------------------------------------------

const DB_FILE_MODE = 0o600;
const DB_DIR_MODE = 0o700;

export class SqliteStore {
  private db: DatabaseSync;
  readonly dbPath: string;
  readonly leaseManager: LeaseManager;
  readonly dataRetention: DataRetention;
  private _migrationApplied: boolean = false;

  constructor(config: BridgeConfig) {
    const dbDir = path.join(config.logRoot, "sqlite");
    mkdirSync(dbDir, { recursive: true, mode: DB_DIR_MODE });
    this.dbPath = path.join(dbDir, "bridge.db");

    // Set restrictive file mode on existing db if possible
    try { chmodSync(this.dbPath, DB_FILE_MODE); } catch { /* may not exist yet */ }

    this.db = new DatabaseSync(this.dbPath);

    // Set restrictive file mode after creation
    try { chmodSync(this.dbPath, DB_FILE_MODE); } catch { /* best-effort */ }

    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 5000");

    // Run migrations
    const migrationResult = runMigrations(this.db, { dbPath: this.dbPath, backupDir: dbDir });
    if (migrationResult.applied.length > 0) {
      this._migrationApplied = true;
      console.log(
        `[sqlite] migrated schema from v${migrationResult.fromVersion} ` +
        `to v${migrationResult.toVersion} (applied: ${migrationResult.applied.join(", ")})`
      );
    }

    this.leaseManager = new LeaseManager(this.db);
    this.dataRetention = new DataRetention(this.db, {
      retentionDays: config.dataRetentionDays,
      walCheckpoint: true,
    });
  }

  get schemaVersion(): number {
    return getSchemaVersion(this.db);
  }

  get migrationApplied(): boolean {
    return this._migrationApplied;
  }

  close(): void {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch { /* best-effort */ }
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

  // ---- Durable inbox: single message insert -----------------------------

  /**
   * Insert a single message into the inbox.
   *
   * Uses ON CONFLICT to safely handle duplicates — SQLite errors that are
   * NOT unique-key violations will propagate as exceptions.
   *
   * Fixes (replaces the old catch-and-return-false pattern):
   *   - Only unique violations are treated as "duplicate"
   *   - Disk full, corruption, I/O errors all throw
   *   - Returns a discriminated result type
   */
  insertInboxMessage(params: {
    accountKey: string;
    messageUid: string;
    peerId: string;
    peerHash?: string;
    rawJson: string;
    text: string;
    payloadJson?: string;
    payloadVersion?: number | null;
    createTimeMs?: number;
    statusOverride?: "skipped" | "rejected";
  }): InboxInsertResult {
    const status = params.statusOverride ?? "pending";
    const now = params.createTimeMs ?? Date.now();

    const result = this.db.prepare(`
      INSERT INTO inbox_messages
        (account_key, message_uid, peer_id, peer_hash, raw_json, text, payload_json, payload_version, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_key, message_uid) DO NOTHING
    `).run(
      params.accountKey,
      params.messageUid,
      params.peerId,
      params.peerHash ?? "",
      params.rawJson,
      params.text,
      params.payloadJson ?? "",
      params.payloadVersion ?? null,
      status,
      now,
      status === "pending" ? null : now,
    );

    // changes === 1 → inserted
    // changes === 0 → duplicate (ON CONFLICT DO NOTHING)
    if (Number(result.changes) === 1) {
      // Get the auto-generated id
      const idRow = this.db.prepare(
        "SELECT id FROM inbox_messages WHERE account_key = ? AND message_uid = ?"
      ).get(params.accountKey, params.messageUid) as Record<string, unknown> | undefined;

      return { status: "inserted", id: Number(idRow?.id ?? 0) };
    }

    return { status: "duplicate" };
  }

  // ---- Durable inbox: batch persist with atomic cursor ------------------

  /**
   * Persist a batch of fetched messages and update the cursor in a single
   * SQLite transaction.
   *
   * Invariant: ALL messages and the cursor are committed atomically, or
   * nothing is. On any non-duplicate error, the transaction rolls back.
   */
  persistFetchedBatch(params: PersistBatchParams): PersistBatchResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let inserted = 0;
      let skipped = 0;

      const stmt = this.db.prepare(`
        INSERT INTO inbox_messages
          (account_key, message_uid, peer_id, peer_hash, raw_json, text, payload_json, payload_version, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_key, message_uid) DO NOTHING
      `);

      for (const msg of params.messages) {
        const status = msg.statusOverride ?? "pending";
        const now = msg.createTimeMs ?? Date.now();

        const result = stmt.run(
          params.accountKey,
          msg.messageUid,
          msg.peerId,
          msg.peerHash,
          msg.rawJson,
          msg.text,
          msg.payloadJson,
          msg.payloadVersion,
          status,
          now,
          status === "pending" ? null : now,
        );

        if (Number(result.changes) === 1) {
          inserted++;
        } else {
          skipped++;
        }
      }

      // Update cursor atomically with message writes
      this.setMeta(`cursor:${params.accountKey}`, params.nextCursor);

      this.db.exec("COMMIT");

      return { inserted, skipped, cursorUpdated: true };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw new Error(
        `persistFetchedBatch failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ---- Claim / lease / complete / fail (via LeaseManager) ----------------

  claimNextMessage(
    accountKey: string,
    options?: { leaseMs?: number; owner?: string; now?: number },
  ) {
    return this.leaseManager.claimNext(accountKey, options);
  }

  completeMessage(id: number, leaseToken: string, scrubEnvelope?: boolean): boolean {
    return this.leaseManager.completeMessage({ id, leaseToken, scrubEnvelope });
  }

  failMessage(
    id: number,
    leaseToken: string,
    error: string,
    options?: { maxAttempts?: number; errorCategory?: string; scrubOnDead?: boolean },
  ): boolean {
    return this.leaseManager.failMessage({
      id,
      leaseToken,
      error,
      maxAttempts: options?.maxAttempts,
      errorCategory: options?.errorCategory,
      scrubOnDead: options?.scrubOnDead,
    });
  }

  skipMessage(id: number): boolean {
    return this.leaseManager.skipMessage({ id });
  }

  rejectMessage(id: number, reason?: string): boolean {
    return this.leaseManager.rejectMessage({ id, reason });
  }

  recoverExpiredLeases(accountKey: string, options?: { now?: number }): number {
    return this.leaseManager.recoverExpiredLeases(accountKey, options);
  }

  renewLease(id: number, leaseToken: string, leaseMs?: number): boolean {
    return this.leaseManager.renewLease({ id, leaseToken, leaseMs });
  }

  startHeartbeat(params: { id: number; leaseToken: string; owner?: string }) {
    return this.leaseManager.startHeartbeat(params);
  }

  /**
   * Count pending (pending or failed) messages for a specific account.
   */
  countPending(accountKey: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM inbox_messages WHERE account_key = ? AND status IN ('pending','failed')"
    ).get(accountKey) as Record<string, number>;
    return Number(row.cnt);
  }

  /**
   * List recent messages for a specific account.
   */
  listRecentMessages(accountKey: string, limit = 20): StoredMessage[] {
    const rows = this.db.prepare(`
      SELECT id, account_key, message_uid, peer_id, raw_json, text, status,
             created_at, lease_until, lease_token, attempts, last_error,
             error_category, completed_at
      FROM inbox_messages
      WHERE account_key = ?
      ORDER BY id DESC LIMIT ?
    `).all(accountKey, limit) as Record<string, unknown>[];
    return rows.map((r) => rowToMsg(r));
  }

  // ---- Cursor persistence -----------------------------------------------

  loadSyncBuf(accountKey: string): string {
    return this.getMeta(`cursor:${accountKey}`) ?? "";
  }

  saveSyncBuf(accountKey: string, buf: string): void {
    this.setMeta(`cursor:${accountKey}`, buf);
  }

  // ---- Failed tasks -----------------------------------------------------

  saveFailedTask(params: {
    id: string;
    sessionKey: string;
    peerId: string;
    prompt: string;
    error: string;
    messageUid?: string;
    runDirectory?: string;
    reasonCode?: string;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO failed_tasks
      (id, session_key, peer_id, prompt, error, message_uid, run_directory, created_at, reason_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.id,
      params.sessionKey,
      params.peerId,
      params.prompt,
      params.error.slice(0, 2000),
      params.messageUid ?? null,
      params.runDirectory ?? null,
      Date.now(),
      params.reasonCode ?? null,
    );
  }

  listFailedTasks(sessionKey: string): Array<{
    id: string;
    prompt: string;
    error: string;
    peerId: string;
    messageUid?: string;
    createdAt: number;
    reasonCode?: string;
  }> {
    const rows = this.db.prepare(`
      SELECT id, prompt, error, peer_id, message_uid, created_at, reason_code
      FROM failed_tasks WHERE session_key = ? ORDER BY created_at DESC
    `).all(sessionKey) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id ?? ""),
      prompt: String(r.prompt ?? ""),
      error: String(r.error ?? ""),
      peerId: String(r.peer_id ?? ""),
      messageUid: r.message_uid != null && String(r.message_uid) !== "" ? String(r.message_uid) : undefined,
      createdAt: Number(r.created_at),
      reasonCode: r.reason_code != null ? String(r.reason_code) : undefined,
    }));
  }

  takeFailedTaskById(sessionKey: string, id: string): {
    id: string;
    prompt: string;
    error: string;
    peerId: string;
    messageUid?: string;
  } | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(
        "SELECT id, prompt, error, peer_id, message_uid, reason_code FROM failed_tasks WHERE session_key = ? AND id = ?"
      ).get(sessionKey, id) as Record<string, unknown> | undefined;
      if (!row) { this.db.exec("COMMIT"); return undefined; }
      this.db.prepare("DELETE FROM failed_tasks WHERE session_key = ? AND id = ?").run(sessionKey, id);
      this.db.exec("COMMIT");
      return {
        id: String(row.id),
        prompt: String(row.prompt),
        error: String(row.error),
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

  // ---- Data retention ---------------------------------------------------

  cleanupExpiredData(now?: number): CleanupResult {
    return this.dataRetention.cleanup(now);
  }

  estimateCleanup(now?: number): CleanupResult {
    return this.dataRetention.estimateCleanup(now);
  }

  scrubResidualPayloads(): number {
    return this.dataRetention.scrubResidualPayloads();
  }

  getDatabaseInfo(): { dbBytes: number; walBytes: number; shmBytes: number } {
    return this.dataRetention.getDatabaseInfo(this.dbPath);
  }

  // ---- Raw exec for tests -----------------------------------------------

  exec(sql: string): void {
    this.db.exec(sql);
  }
}

// ---- Helpers -------------------------------------------------------------

function rowToMsg(row: Record<string, unknown>): StoredMessage {
  return {
    id: Number(row.id),
    messageUid: String(row.message_uid ?? ""),
    accountKey: String(row.account_key ?? ""),
    peerId: String(row.peer_id ?? ""),
    rawJson: String(row.raw_json ?? ""),
    text: String(row.text ?? ""),
    status: (String(row.status ?? "")) as StoredMessage["status"],
    createdAt: Number(row.created_at),
    leaseUntil: row.lease_until != null ? Number(row.lease_until) : null,
    leaseToken: row.lease_token != null ? String(row.lease_token) : null,
    attempts: Number(row.attempts),
    lastError: row.last_error != null ? String(row.last_error) : null,
    errorCategory: row.error_category != null ? String(row.error_category) : null,
    completedAt: row.completed_at != null ? Number(row.completed_at) : null,
  };
}
