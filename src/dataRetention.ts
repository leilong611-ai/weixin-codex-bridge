/**
 * Data retention and cleanup for SQLite inbox.
 *
 * Provides:
 *   1. Deletion of expired records (completed, skipped, rejected, dead).
 *   2. Payload scrubbing for minimal retention.
 *   3. WAL checkpoint management.
 *   4. Safe cleanup even during concurrent access.
 */

import type { DatabaseSync } from "node:sqlite";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CleanupResult {
  deletedMessages: number;
  deletedFailedTasks: number;
  deletedOldAudit: boolean;
  walCheckpointFrames: number;
}

export interface DataRetentionConfig {
  /** Retention period in days (default: 7) */
  retentionDays: number;
  /** Whether to run WAL checkpoint after cleanup */
  walCheckpoint: boolean;
}

// ---------------------------------------------------------------------------
// Data Retention
// ---------------------------------------------------------------------------

export class DataRetention {
  constructor(
    private readonly db: DatabaseSync,
    private readonly config: DataRetentionConfig,
  ) {}

  /**
   * Run full cleanup cycle.
   * Call this on startup and periodically (every 6-24h).
   */
  cleanup(now?: number): CleanupResult {
    const cutoffMs = (now ?? Date.now()) - this.config.retentionDays * 86_400_000;
    const result: CleanupResult = {
      deletedMessages: 0,
      deletedFailedTasks: 0,
      deletedOldAudit: false,
      walCheckpointFrames: 0,
    };

    // 1. Delete old completed/skipped/rejected messages
    const deleteResult = this.db.prepare(`
      DELETE FROM inbox_messages
      WHERE status IN ('completed', 'skipped', 'rejected', 'dead')
        AND completed_at IS NOT NULL
        AND completed_at < ?
    `).run(cutoffMs);
    result.deletedMessages = Number(deleteResult.changes);

    // 2. Delete old failed tasks
    const deleteFailedResult = this.db.prepare(`
      DELETE FROM failed_tasks
      WHERE created_at < ?
    `).run(cutoffMs);
    result.deletedFailedTasks = Number(deleteFailedResult.changes);

    // 3. Remove old runtime audit metadata
    // (runtime_metadata is small; only clean entries older than 2x retention)
    const oldMetaCutoff = cutoffMs - this.config.retentionDays * 86_400_000;

    // 4. WAL checkpoint
    if (this.config.walCheckpoint) {
      try {
        const cpResult = this.db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as Record<string, unknown>;
        if (cpResult) {
          result.walCheckpointFrames = Number(
            (cpResult as Record<string, unknown>).wal_checkpoint ?? 0,
          );
        }
      } catch {
        // Non-critical — WAL checkpoint can fail under concurrent access
      }
    }

    return result;
  }

  /**
   * Get an estimate of how many records would be cleaned up.
   * Does NOT modify the database.
   */
  estimateCleanup(now?: number): CleanupResult {
    const cutoffMs = (now ?? Date.now()) - this.config.retentionDays * 86_400_000;

    const countResult = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM inbox_messages
      WHERE status IN ('completed', 'skipped', 'rejected', 'dead')
        AND completed_at IS NOT NULL
        AND completed_at < ?
    `).get(cutoffMs) as Record<string, number> | undefined;

    const failedCount = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM failed_tasks
      WHERE created_at < ?
    `).get(cutoffMs) as Record<string, number> | undefined;

    return {
      deletedMessages: Number(countResult?.cnt ?? 0),
      deletedFailedTasks: Number(failedCount?.cnt ?? 0),
      deletedOldAudit: false,
      walCheckpointFrames: 0,
    };
  }

  /**
   * Scrub all completed/skipped/rejected/dead messages that still have payload.
   * Useful as a privacy maintenance operation.
   */
  scrubResidualPayloads(): number {
    const result = this.db.prepare(`
      UPDATE inbox_messages
      SET raw_json = '', text = ''
      WHERE status IN ('completed', 'skipped', 'rejected', 'dead')
        AND (raw_json != '' OR text != '')
    `).run();
    return Number(result.changes);
  }

  /**
   * Get total database size information (for diagnostics).
   */
  getDatabaseInfo(dbPath: string): {
    dbBytes: number;
    walBytes: number;
    shmBytes: number;
  } {
    const dir = path.dirname(dbPath);
    const name = path.basename(dbPath);

    const result = { dbBytes: 0, walBytes: 0, shmBytes: 0 };

    for (const suffix of ["", "-wal", "-shm"]) {
      const filePath = path.join(dir, `${name}${suffix}`);
      try {
        const stats = statSync(filePath);
        if (suffix === "") result.dbBytes = stats.size;
        else if (suffix === "-wal") result.walBytes = stats.size;
        else result.shmBytes = stats.size;
      } catch {
        // File may not exist (e.g., SHM not always present)
      }
    }

    return result;
  }
}
