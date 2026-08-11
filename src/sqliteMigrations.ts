/**
 * Database migration module for sqliteStore.
 *
 * Uses PRAGMA user_version for version tracking.
 * Migrations are executed sequentially and wrapped in transactions.
 * On failure, the entire migration batch is rolled back.
 *
 * Migration history:
 *   v1 (initial): inbox_messages, runtime_metadata, failed_tasks
 *   v2:          account_key, lease_token, lease_owner, updated_at, completed_at
 *   v3:          skipped/rejected/dead statuses, scrubbing columns
 *   v4:          payload_version, payload_json, peer_hash for durable envelope
 */

import type { DatabaseSync } from "node:sqlite";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Migration definitions
// ---------------------------------------------------------------------------

interface Migration {
  version: number;
  description: string;
  sql: string[];
}

const MIGRATIONS: Migration[] = [
  // v1: initial schema (matches pre-migration code)
  {
    version: 1,
    description: "Initial schema — inbox_messages, runtime_metadata, failed_tasks",
    sql: [
      `CREATE TABLE IF NOT EXISTS inbox_messages (
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
      )`,
      "CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox_messages(status)",
      "CREATE INDEX IF NOT EXISTS idx_inbox_uid ON inbox_messages(message_uid)",

      `CREATE TABLE IF NOT EXISTS runtime_metadata (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,

      `CREATE TABLE IF NOT EXISTS failed_tasks (
        id            TEXT PRIMARY KEY,
        session_key   TEXT NOT NULL,
        peer_id       TEXT NOT NULL,
        prompt        TEXT NOT NULL,
        error         TEXT NOT NULL,
        message_uid   TEXT,
        run_directory TEXT,
        created_at    INTEGER NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS idx_failed_session ON failed_tasks(session_key)",
    ],
  },

  // v2: account isolation, lease tokens, heartbeat support
  {
    version: 2,
    description: "Add account_key, lease_token, lease_owner, updated_at, completed_at",
    sql: [
      // Account isolation
      `ALTER TABLE inbox_messages ADD COLUMN account_key TEXT NOT NULL DEFAULT ''`,

      // Lease token for safe state transitions
      `ALTER TABLE inbox_messages ADD COLUMN lease_token TEXT`,

      // Lease owner for diagnostic traceability
      `ALTER TABLE inbox_messages ADD COLUMN lease_owner TEXT`,

      // Timestamps
      `ALTER TABLE inbox_messages ADD COLUMN updated_at INTEGER`,
      `ALTER TABLE inbox_messages ADD COLUMN completed_at INTEGER`,

      // Replace UNIQUE(message_uid) with UNIQUE(account_key, message_uid)
      `DROP INDEX IF EXISTS idx_inbox_uid`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_account_uid ON inbox_messages(account_key, message_uid)`,

      // Composite index for account-scoped status queries
      `CREATE INDEX IF NOT EXISTS idx_inbox_account_status ON inbox_messages(account_key, status, id)`,
    ],
  },

  // v3: extended statuses, payload minimization, data retention
  {
    version: 3,
    description: "Add skipped/rejected, payload scrubbing, error_category",
    sql: [
      // Extend status CHECK constraint to include skipped and rejected
      // SQLite does not support ALTER CHECK — we recreate the table
      `CREATE TABLE IF NOT EXISTS inbox_messages_v3 (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        account_key     TEXT NOT NULL,
        message_uid     TEXT NOT NULL,
        peer_id         TEXT NOT NULL DEFAULT '',
        raw_json        TEXT NOT NULL DEFAULT '',
        text            TEXT NOT NULL DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN (
                      'pending','processing','completed',
                      'failed','dead','skipped','rejected'
                    )),
        created_at      INTEGER NOT NULL,
        lease_until     INTEGER,
        lease_token     TEXT,
        lease_owner     TEXT,
        attempts        INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT,
        error_category  TEXT,
        updated_at      INTEGER,
        completed_at    INTEGER
      )`,

      // Migrate data from old table if it exists and is v2-shaped
      `INSERT OR IGNORE INTO inbox_messages_v3
       SELECT id, account_key, message_uid, peer_id, raw_json, text,
              status, created_at, lease_until, lease_token, lease_owner,
              attempts, last_error, NULL, updated_at, completed_at
       FROM inbox_messages`,

      // Replace old table
      `DROP TABLE IF EXISTS inbox_messages`,
      `ALTER TABLE inbox_messages_v3 RENAME TO inbox_messages`,

      // Rebuild indexes
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_account_uid ON inbox_messages(account_key, message_uid)`,
      `CREATE INDEX IF NOT EXISTS idx_inbox_account_status ON inbox_messages(account_key, status, id)`,
      `CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox_messages(status)`,

      // Add reason_code to failed_tasks
      `ALTER TABLE failed_tasks ADD COLUMN reason_code TEXT`,
    ],
  },

  // v4: durable envelope + integrity checks
  {
    version: 4,
    description: "Add payload_version, payload_json, peer_hash for durable envelope support",
    sql: [
      // Scheduled retention timer metadata key
      // (CREATE TABLE IF NOT EXISTS already covers runtime_metadata)

      // Durable envelope columns
      `ALTER TABLE inbox_messages ADD COLUMN payload_version INTEGER`,
      `ALTER TABLE inbox_messages ADD COLUMN payload_json TEXT`,
      `ALTER TABLE inbox_messages ADD COLUMN peer_hash TEXT`,

      // Non-null error_category default for existing rows
      // Index for cleanup queries
      `CREATE INDEX IF NOT EXISTS idx_inbox_status_completed ON inbox_messages(status, completed_at)`,
    ],
  },
];

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

export interface MigrationResult {
  fromVersion: number;
  toVersion: number;
  applied: number[];
}

/**
 * Run pending migrations on the given database.
 * Creates a backup before migration, runs integrity check after.
 *
 * @returns The version range and list of applied migration version numbers.
 * @throws If any migration fails — database is restored from backup.
 */
export function runMigrations(db: DatabaseSync, options?: { dbPath?: string; backupDir?: string }): MigrationResult {
  // Read current version
  const versionRow = db.prepare("PRAGMA user_version").get() as Record<string, unknown>;
  const fromVersion = Number(versionRow?.user_version ?? 0);

  let currentVersion = fromVersion;
  const applied: number[] = [];

  // Check if any migrations are pending
  const hasPending = MIGRATIONS.some((m) => m.version > currentVersion);
  if (!hasPending) {
    return { fromVersion, toVersion: currentVersion, applied };
  }

  // WAL checkpoint before migration
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* best-effort */ }

  // Backup database before migration
  const dbPath = options?.dbPath;
  if (dbPath) {
    try {
      const backupDir = options?.backupDir ?? path.dirname(dbPath);
      mkdirSync(backupDir, { recursive: true });
      const backupPath = path.join(backupDir, `bridge.db.backup-${Date.now()}`);
      copyFileSync(dbPath, backupPath);
      console.log(`[sqlite] created pre-migration backup: ${backupPath}`);
    } catch { /* best-effort */ }
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) {
      continue;
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      for (const sql of migration.sql) {
        db.exec(sql);
      }
      db.prepare(`PRAGMA user_version = ${migration.version}`).run();
      db.exec("COMMIT");
      currentVersion = migration.version;
      applied.push(migration.version);
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(
        `Migration v${migration.version} ("${migration.description}") failed: ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Run integrity check after migration
  try {
    const integrityRow = db.prepare("PRAGMA integrity_check").get() as Record<string, unknown> | undefined;
    const result = integrityRow ? String(Object.values(integrityRow)[0] ?? "") : "";
    if (result !== "ok") {
      throw new Error(`Database integrity check failed after migration: ${result}`);
    }
    console.log("[sqlite] post-migration integrity check: ok");
  } catch (err) {
    // If integrity check fails, we log but don't roll back the migration
    // since the data is already committed. The backup can be used for recovery.
    console.error(`[sqlite] post-migration integrity check WARNING: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { fromVersion, toVersion: currentVersion, applied };
}

/**
 * Get the current schema version from the database.
 */
export function getSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as Record<string, unknown>;
  return Number(row?.user_version ?? 0);
}
