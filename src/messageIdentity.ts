/**
 * Message identity and UID generation.
 *
 * Provides stable, account-scoped message identifiers that:
 * 1. Never expose real account IDs or peer IDs in the UID.
 * 2. Differentiate messages from different accounts.
 * 3. Have a deterministic fallback when message_id is absent.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Hashing helpers
// ---------------------------------------------------------------------------

/**
 * Create a stable, prefix-based hash of a string.
 * Uses SHA-256 and returns the first `length` hex characters.
 */
function stableHash(input: string, length = 16): string {
  return createHash("sha256").update(input).digest("hex").slice(0, length);
}

/**
 * Build a stable account pseudonym from the real account ID.
 * This is used in UIDs — never expose the raw account ID in a UID.
 */
export function makeAccountHash(accountId: string): string {
  return stableHash(accountId, 16);
}

/**
 * Build a stable peer pseudonym from the real peer ID.
 */
export function makePeerHash(peerId: string): string {
  return stableHash(peerId, 16);
}

// ---------------------------------------------------------------------------
// Message UID
// ---------------------------------------------------------------------------

export interface MessageIdentityParams {
  accountId: string;
  messageId?: number | string | null;
  fromUserId?: string | null;
  createTimeMs?: number | null;
  sessionId?: string | null;
  text?: string | null;
  contextToken?: string | null;
}

/**
 * Build a stable, unique message identifier with account scope.
 *
 * Priority:
 *   1. weixin:<accountHash>:msg:<messageId>  (when message_id exists)
 *   2. weixin:<accountHash>:hash:<bodyHash>   (fallback hash-based)
 *
 * @example
 *   "weixin:a1b2c3d4:msg:12345"
 *   "weixin:a1b2c3d4:hash:e5f6a7b8c9d0"
 */
export function makeMessageUid(params: MessageIdentityParams): string {
  const accountHash = makeAccountHash(params.accountId);

  if (params.messageId != null && params.messageId !== "") {
    return `weixin:${accountHash}:msg:${params.messageId}`;
  }

  // Fallback: hash-based identifier
  const bodyHash = stableHash(
    [
      params.fromUserId ?? "",
      params.createTimeMs ?? 0,
      params.sessionId ?? "",
      params.text ?? "",
      params.contextToken ?? "",
    ].join("\0"),
    20,
  );

  return `weixin:${accountHash}:hash:${bodyHash}`;
}
