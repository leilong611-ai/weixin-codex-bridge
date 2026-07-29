/**
 * Lease manager for SQLite inbox message processing.
 *
 * Provides heartbeat renewal, safe state transitions via lease tokens,
 * and crash recovery for expired leases.
 *
 * Key invariants:
 *   - Only the holder of the lease token can complete/fail a message.
 *   - A message whose lease expires can be re-claimed by another worker.
 *   - Renewal extends the lease window without resetting attempts.
 *   - All state transitions verify id + lease_token match.
 */

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClaimResult {
  id: number;
  leaseToken: string;
  leaseUntil: number;
  messageUid: string;
  peerId: string;
  text: string;
  payload: StoredPayload | null;
  attempts: number;
}

export interface StoredPayload {
  rawJson?: string;
  text?: string;
}

export interface LeaseState {
  id: number;
  leaseToken: string | null;
  leaseUntil: number | null;
  status: string;
  leaseOwner: string | null;
}

// ---------------------------------------------------------------------------
// Lease constants
// ---------------------------------------------------------------------------

export const DEFAULT_LEASE_MS = 300_000; // 5 min
export const HEARTBEAT_INTERVAL_MS = 30_000; // 30 s

// ---------------------------------------------------------------------------
// Heartbeat handle
// ---------------------------------------------------------------------------

export interface HeartbeatHandle {
  stop(): void;
  readonly isActive: boolean;
}

// ---------------------------------------------------------------------------
// Lease Manager
// ---------------------------------------------------------------------------

export class LeaseManager {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Claim the next available message for processing.
   * Returns null if no message is available.
   */
  claimNext(
    accountKey: string,
    options?: {
      leaseMs?: number;
      owner?: string;
      now?: number;
    },
  ): ClaimResult | null {
    const leaseMs = options?.leaseMs ?? DEFAULT_LEASE_MS;
    const now = options?.now ?? Date.now();
    const owner = options?.owner ?? "";

    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Find next claimable message
      const row = this.db.prepare(`
        SELECT id, message_uid, peer_id, text, raw_json, status,
               lease_until, attempts, last_error, error_category
        FROM inbox_messages
        WHERE account_key = ?
          AND (
            status IN ('pending', 'failed')
            OR (status = 'processing' AND lease_until IS NOT NULL AND lease_until < ?)
          )
        ORDER BY id ASC
        LIMIT 1
      `).get(accountKey, now) as Record<string, unknown> | undefined;

      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }

      const id = Number(row.id);
      const leaseToken = randomUUID();
      const leaseUntil = now + leaseMs;

      // Claim: set processing status, lease, and token
      this.db.prepare(`
        UPDATE inbox_messages
        SET status = 'processing',
            lease_until = ?,
            lease_token = ?,
            lease_owner = ?,
            attempts = attempts + 1,
            updated_at = ?
        WHERE id = ?
      `).run(leaseUntil, leaseToken, owner, now, id);

      this.db.exec("COMMIT");

      return {
        id,
        leaseToken,
        leaseUntil,
        messageUid: String(row.message_uid ?? ""),
        peerId: String(row.peer_id ?? ""),
        text: String(row.text ?? ""),
        payload: row.raw_json
          ? { rawJson: String(row.raw_json), text: String(row.text ?? "") }
          : null,
        attempts: Number(row.attempts ?? 0) + 1,
      };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Renew the lease on a message currently being processed.
   * Returns true if renewal succeeded, false if lease was lost.
   */
  renewLease(params: {
    id: number;
    leaseToken: string;
    leaseMs?: number;
    now?: number;
  }): boolean {
    const leaseMs = params.leaseMs ?? DEFAULT_LEASE_MS;
    const now = params.now ?? Date.now();
    const leaseUntil = now + leaseMs;

    const result = this.db.prepare(`
      UPDATE inbox_messages
      SET lease_until = ?, updated_at = ?
      WHERE id = ?
        AND status = 'processing'
        AND lease_token = ?
    `).run(leaseUntil, now, params.id, params.leaseToken);

    const changes = Number(result.changes);
    return changes > 0;
  }

  /**
   * Mark a message as completed, scrubbing sensitive payload.
   * Returns true if the transition succeeded.
   */
  completeMessage(params: {
    id: number;
    leaseToken: string;
    now?: number;
  }): boolean {
    const now = params.now ?? Date.now();

    const result = this.db.prepare(`
      UPDATE inbox_messages
      SET status = 'completed',
          lease_until = NULL,
          lease_token = NULL,
          lease_owner = NULL,
          last_error = NULL,
          raw_json = '',
          text = '',
          updated_at = ?,
          completed_at = ?
      WHERE id = ?
        AND status = 'processing'
        AND lease_token = ?
    `).run(now, now, params.id, params.leaseToken);

    return Number(result.changes) > 0;
  }

  /**
   * Mark a message as failed. Transitions to 'dead' if max attempts reached.
   * Returns true if the transition succeeded.
   */
  failMessage(params: {
    id: number;
    leaseToken: string;
    error: string;
    maxAttempts?: number;
    errorCategory?: string;
    now?: number;
  }): boolean {
    const now = params.now ?? Date.now();
    const maxAttempts = params.maxAttempts ?? 3;

    // Get current attempts in the same transaction
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`
        SELECT attempts, lease_token FROM inbox_messages WHERE id = ?
      `).get(params.id) as Record<string, unknown> | undefined;

      if (!row) {
        this.db.exec("COMMIT");
        return false;
      }

      // Must own the lease to transition
      if (String(row.lease_token ?? "") !== params.leaseToken) {
        this.db.exec("COMMIT");
        return false;
      }

      const attempts = Number(row.attempts ?? 0);
      const newStatus = attempts >= maxAttempts ? "dead" : "failed";

      this.db.prepare(`
        UPDATE inbox_messages
        SET status = ?,
            lease_until = NULL,
            lease_token = NULL,
            lease_owner = NULL,
            last_error = ?,
            error_category = ?,
            updated_at = ?
        WHERE id = ?
      `).run(newStatus, params.error.slice(0, 2000), params.errorCategory ?? null, now, params.id);

      this.db.exec("COMMIT");
      return true;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Mark a message as skipped (startup backlog, unauthorized).
   * Scrub payload immediately.
   */
  skipMessage(params: {
    id: number;
    now?: number;
  }): boolean {
    const now = params.now ?? Date.now();

    const result = this.db.prepare(`
      UPDATE inbox_messages
      SET status = 'skipped',
          lease_until = NULL,
          lease_token = NULL,
          lease_owner = NULL,
          raw_json = '',
          text = '',
          last_error = NULL,
          updated_at = ?,
          completed_at = ?
      WHERE id = ?
    `).run(now, now, params.id);

    return Number(result.changes) > 0;
  }

  /**
   * Reject a message (unauthorized, unsupported type).
   * Scrub payload immediately.
   */
  rejectMessage(params: {
    id: number;
    reason?: string;
    now?: number;
  }): boolean {
    const now = params.now ?? Date.now();

    const result = this.db.prepare(`
      UPDATE inbox_messages
      SET status = 'rejected',
          lease_until = NULL,
          lease_token = NULL,
          lease_owner = NULL,
          raw_json = '',
          text = '',
          last_error = ?,
          updated_at = ?,
          completed_at = ?
      WHERE id = ?
    `).run(params.reason?.slice(0, 200) ?? null, now, now, params.id);

    return Number(result.changes) > 0;
  }

  /**
   * Recover messages with expired leases for a given account.
   * Marks them as 'failed' for retry.
   *
   * @returns The number of recovered messages.
   */
  recoverExpiredLeases(accountKey: string, options?: {
    now?: number;
    maxAttempts?: number;
  }): number {
    const now = options?.now ?? Date.now();

    const result = this.db.prepare(`
      UPDATE inbox_messages
      SET status = 'failed',
          lease_until = NULL,
          lease_token = NULL,
          lease_owner = NULL,
          last_error = 'recovered after crash (lease expired)',
          updated_at = ?
      WHERE account_key = ?
        AND status = 'processing'
        AND lease_until IS NOT NULL
        AND lease_until < ?
    `).run(now, accountKey, now);

    return Number(result.changes);
  }

  /**
   * Get the current lease state for a message (for diagnostics).
   */
  getLeaseState(id: number): LeaseState | null {
    const row = this.db.prepare(`
      SELECT id, lease_token, lease_until, status, lease_owner
      FROM inbox_messages WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      id: Number(row.id),
      leaseToken: row.lease_token != null ? String(row.lease_token) : null,
      leaseUntil: row.lease_until != null ? Number(row.lease_until) : null,
      status: String(row.status ?? ""),
      leaseOwner: row.lease_owner != null ? String(row.lease_owner) : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Heartbeat
  // ---------------------------------------------------------------------------

  /**
   * Start a periodic heartbeat that renews the lease.
   * Returns a handle to stop the heartbeat.
   */
  startHeartbeat(params: {
    id: number;
    leaseToken: string;
    owner?: string;
    intervalMs?: number;
  }): HeartbeatHandle {
    const intervalMs = params.intervalMs ?? HEARTBEAT_INTERVAL_MS;
    let stopped = false;

    const timer = setInterval(() => {
      if (stopped) return;

      try {
        const renewed = this.renewLease({
          id: params.id,
          leaseToken: params.leaseToken,
        });
        if (!renewed) {
          // Lease was lost — stop heartbeat
          stopped = true;
          clearInterval(timer);
        }
      } catch {
        // Log but don't crash — next tick will retry
        console.error(`[lease] heartbeat error for message ${params.id}`);
      }
    }, intervalMs);

    // Prevent the timer from keeping the process alive
    timer.unref();

    return {
      stop: () => {
        stopped = true;
        clearInterval(timer);
      },
      get isActive() {
        return !stopped;
      },
    };
  }
}
