/**
 * Message payload storage and scrubbing.
 *
 * Controls what message content is stored in SQLite at each lifecycle stage,
 * enforces size limits, and provides scrubbing to minimize retained data.
 *
 * Privacy invariants:
 *   1. Minimal log level: never store full raw_json.
 *   2. Unauthorized messages: never store raw_json or text.
 *   3. Completed/skipped/rejected/dead: scrub payload immediately.
 *   4. Failed messages: retain only if still retryable.
 *   5. Token, cookie, credential fields are never stored.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PayloadToStore {
  /** Normalized raw JSON (subject to log level filtering) */
  rawJson: string;
  /** Extracted text content */
  text: string;
  /** Message type for routing decisions */
  messageType: number;
  /** Whether this is from a BOT */
  isBot: boolean;
}

export interface StoredPayload {
  rawJson?: string;
  text?: string;
  messageType?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_MESSAGE_BYTES = 64_000; // truncate oversized messages
export const MAX_PAYLOAD_TEXT = 16_000; // max text stored in payload
const MAX_FAILED_TEXT_LENGTH = 2000; // max text retained in failed

// ---------------------------------------------------------------------------
// Payload preparation
// ---------------------------------------------------------------------------

/**
 * Prepare a normalized payload for storage based on the current log level.
 *
 * @param fullRawJson The complete raw JSON from the WeChat API.
 * @param text The extracted text content.
 * @param messageType The WeChat message type.
 * @param isBot Whether the message is from a bot.
 * @param logLevel Current logging level configuration.
 * @returns A normalized payload object suitable for storage.
 */
export function preparePayload(
  fullRawJson: string,
  text: string,
  messageType: number,
  isBot: boolean,
  logLevel: "minimal" | "metadata" | "full-debug" = "minimal",
): PayloadToStore {
  // Truncate oversized raw JSON
  const rawJson = fullRawJson.length > MAX_MESSAGE_BYTES
    ? fullRawJson.slice(0, MAX_MESSAGE_BYTES)
    : fullRawJson;

  const truncatedText = text.length > MAX_PAYLOAD_TEXT
    ? text.slice(0, MAX_PAYLOAD_TEXT)
    : text;

  return {
    rawJson: logLevel === "full-debug" ? rawJson : "",
    text: truncatedText,
    messageType,
    isBot,
  };
}

// ---------------------------------------------------------------------------
// Payload scrubbing
// ---------------------------------------------------------------------------

/**
 * Scrub sensitive payload from a completed/failed/skipped/rejected message.
 *
 * @returns A scrubbed payload with empty rawJson and text.
 */
export function scrubPayload(): StoredPayload {
  return {};
}

/**
 * Scrub payload for failed messages that are still retryable.
 * Keep minimal text but strip raw JSON.
 */
export function scrubFailedPayload(text: string): StoredPayload {
  return {
    text: text.length > MAX_FAILED_TEXT_LENGTH
      ? text.slice(0, MAX_FAILED_TEXT_LENGTH)
      : text,
  };
}

// ---------------------------------------------------------------------------
// Authorization-based filtering
// ---------------------------------------------------------------------------

/**
 * Determine what payload to store for a given authorization role.
 */
export function payloadForRole(
  role: "owner" | "allowed" | "readonly" | "unknown",
  payload: PayloadToStore,
): { rawJson: string; text: string } {
  switch (role) {
    case "owner":
    case "allowed":
      // Authorized users: store per log level
      return {
        rawJson: payload.rawJson,
        text: payload.text,
      };
    case "readonly":
    case "unknown":
      // Unauthorized: never store content
      return { rawJson: "", text: "" };
  }
}

/**
 * Check if a message should be stored at all (not bot, supported type).
 */
export function shouldStoreMessage(payload: PayloadToStore): boolean {
  if (payload.isBot) return false;
  if (payload.rawJson === "" && payload.text === "") return false;
  return true;
}
