/**
 * Durable message envelope — the structured payload stored in SQLite
 * for processing recovery.
 *
 * This replaces the previous pattern of storing raw WeChat API JSON.
 * The envelope contains only the fields needed to reconstruct processing
 * context after a crash or restart.
 *
 * After a message reaches a terminal state (completed/skipped/rejected/dead),
 * the envelope MUST be cleared.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Versioned envelope
// ---------------------------------------------------------------------------

export interface DurableMessageEnvelopeV1 {
  /** Schema version (must be 1) */
  version: 1;
  /** Stable message UID */
  messageUid: string;
  /** WeChat API message ID, if available */
  messageId?: string | number;
  /** Message type (USER=1, BOT=2, etc.) */
  messageType: number;
  /**
   * The real peer route ID needed to send replies via WeChat API.
   * Stored temporarily during pending/processing — MUST be cleared
   * when message reaches a terminal state.
   */
  peerRouteId: string;
  /** Context token for reply threading */
  contextToken?: string;
  /** Extracted text content */
  text: string;
  /** Message creation timestamp (ms since epoch) */
  createTimeMs?: number;
}

// ---------------------------------------------------------------------------
// Inbound message classification — happens BEFORE persistence
// ---------------------------------------------------------------------------

export type InboundDecision =
  | { action: "process"; reasonCode: string }
  | { action: "safe-command"; reasonCode: string }
  | { action: "reject"; reasonCode: string }
  | { action: "skip"; reasonCode: string };

export interface ClassifyParams {
  messageType: number;
  peerId: string | null | undefined;
  text: string | null | undefined;
  isBot: boolean;
  role: "owner" | "allowed" | "readonly" | "unknown";
  isStartupBacklog: boolean;
  isOversized: boolean;
  isBridgeCommand: boolean;
}

/**
 * Classify an inbound message before persistence.
 * The decision determines how the message is stored and whether it
 * will be processed by a worker.
 */
export function classifyInboundMessage(params: ClassifyParams): InboundDecision {
  // BOT messages are always skip
  if (params.isBot) {
    return { action: "skip", reasonCode: "bot_message" };
  }

  // Missing peer ID
  if (!params.peerId) {
    return { action: "skip", reasonCode: "missing_peer_id" };
  }

  // Startup backlog
  if (params.isStartupBacklog) {
    return { action: "skip", reasonCode: "startup_backlog" };
  }

  // Unknown users
  if (params.role === "unknown") {
    return { action: "reject", reasonCode: "unauthorized" };
  }

  // Readonly role cannot execute
  if (params.role === "readonly") {
    return { action: "reject", reasonCode: "readonly_cannot_execute" };
  }

  // Oversized messages
  if (params.isOversized) {
    return { action: "reject", reasonCode: "oversized" };
  }

  // Non-text, unsupported media
  if (!params.text && !params.isBridgeCommand) {
    return { action: "reject", reasonCode: "unsupported_media" };
  }

  // Owner/allowed : normal processing
  return { action: "process", reasonCode: "authorized" };
}

// ---------------------------------------------------------------------------
// Envelope construction
// ---------------------------------------------------------------------------

/**
 * Build a durable envelope from raw WeChat message data.
 * This is the ONLY way to create envelopes for storage.
 */
export function buildEnvelope(params: {
  messageUid: string;
  messageId?: number | string;
  messageType: number;
  peerRouteId: string;
  contextToken?: string;
  text: string;
  createTimeMs?: number;
}): DurableMessageEnvelopeV1 {
  return {
    version: 1,
    messageUid: params.messageUid,
    messageId: params.messageId,
    messageType: params.messageType,
    peerRouteId: params.peerRouteId,
    contextToken: params.contextToken,
    text: params.text,
    createTimeMs: params.createTimeMs,
  };
}

// ---------------------------------------------------------------------------
// Validate and hydrate an envelope from stored JSON
// ---------------------------------------------------------------------------

/**
 * Parse a stored envelope JSON string.
 * Returns the envelope if valid, or an error reason if malformed.
 */
export function parseEnvelope(
  jsonString: string | null | undefined,
): { ok: true; envelope: DurableMessageEnvelopeV1 } | { ok: false; reason: string } {
  if (!jsonString) {
    return { ok: false, reason: "missing_payload" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: "not_an_object" };
  }

  const obj = parsed as Record<string, unknown>;

  // Verify version
  if (obj.version !== 1) {
    return { ok: false, reason: `unsupported_version:${obj.version ?? "undefined"}` };
  }

  // Verify required fields
  if (typeof obj.messageUid !== "string" || !obj.messageUid) {
    return { ok: false, reason: "missing_message_uid" };
  }

  if (typeof obj.messageType !== "number") {
    return { ok: false, reason: "missing_message_type" };
  }

  if (typeof obj.peerRouteId !== "string" || !obj.peerRouteId) {
    return { ok: false, reason: "missing_peer_route_id" };
  }

  if (typeof obj.text !== "string") {
    return { ok: false, reason: "missing_text" };
  }

  return {
    ok: true,
    envelope: {
      version: 1,
      messageUid: String(obj.messageUid ?? ""),
      messageId: obj.messageId != null ? (typeof obj.messageId === "number" ? obj.messageId : String(obj.messageId)) : undefined,
      messageType: Number(obj.messageType ?? 0),
      peerRouteId: String(obj.peerRouteId ?? ""),
      contextToken: obj.contextToken != null ? String(obj.contextToken) : undefined,
      text: String(obj.text ?? ""),
      createTimeMs: obj.createTimeMs != null ? Number(obj.createTimeMs) : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Size constants
// ---------------------------------------------------------------------------

/**
 * Max inbound message byte length before UTF-8 encoding.
 * Checked with Buffer.byteLength BEFORE truncation.
 */
export const MAX_INBOUND_MESSAGE_BYTES = 64_000;

/**
 * Max bytes for stored debug payload (raw_json).
 */
export const MAX_STORED_DEBUG_BYTES = 64_000;

/**
 * Max bytes for error summary text.
 */
export const MAX_ERROR_SUMMARY_BYTES = 2_000;
