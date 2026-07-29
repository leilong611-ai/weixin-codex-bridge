/**
 * Runtime data redaction for Weixin Codex Bridge.
 *
 * All logs, diagnostics, and user-facing output must pass through redact()
 * before being written to disk, sent to WeChat, or returned via the console API.
 *
 * Redaction is one-way — the original values are replaced with placeholders.
 */

// ---------------------------------------------------------------------------
// Patterns that must be redacted
// ---------------------------------------------------------------------------

interface RedactRule {
  label: string;
  pattern: RegExp;
  replacement: string;
}

const REDACT_RULES: RedactRule[] = [
  // Bearer tokens in Authorization headers
  { label: "bearer-token", pattern: /(Authorization:\s*Bearer\s+)([A-Za-z0-9._/+~=-]{8,})/gi, replacement: "$1[REDACTED]" },
  { label: "bearer-token-json", pattern: /"(bearer|token|access_token|refresh_token)"\s*:\s*"[^"]{8,}"/gi, replacement: '"$1":"[REDACTED]"' },
  // Bot tokens
  { label: "bot-token", pattern: /(botToken|bot_token)\s*[:=]\s*"([^"]{8,})"/gi, replacement: '$1:"[REDACTED]"' },
  // Cookies
  { label: "cookie", pattern: /(cookie|cookie)\s*[:=]\s*"[^"]{8,}"/gi, replacement: '$1:"[REDACTED]"' },
  // WeChat account IDs
  { label: "weixin-account-id", pattern: /([A-Za-z0-9._-]{8,}@im\.bot)/g, replacement: "[ACCOUNT-ID]" },
  // WeChat wxid
  { label: "weixin-wxid", pattern: /(wxid_[A-Za-z0-9_-]{6,})/g, replacement: "[WXID]" },
  // Peer IDs (from_user_id in logs)
  { label: "peer-id", pattern: /(from_user_id|to_user_id|peerId)\s*[:=]\s*"([^"]{6,})"/gi, replacement: '$1:"[REDACTED]"' },
  // Session IDs
  { label: "session-id", pattern: /(session_id|codexSessionId|sessionId)\s*[:=]\s*"([a-zA-Z0-9-]{8,})"/gi, replacement: '$1:"[REDACTED]"' },
  // Windows user paths
  { label: "windows-path", pattern: /([A-Za-z]:\\Users\\)[A-Za-z0-9._-]+/g, replacement: "$1[USER]" },
  // macOS user paths
  { label: "macos-path", pattern: /(\/Users\/)[A-Za-z0-9._-]+/g, replacement: "$1[USER]" },
  // Linux home paths
  { label: "linux-path", pattern: /(\/home\/)[A-Za-z0-9._-]+/g, replacement: "$1[USER]" },
  // Email addresses
  { label: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replacement: "[EMAIL]" },
  // Mainland China phone numbers
  { label: "phone", pattern: /\b1[3-9]\d{9}\b/g, replacement: "[PHONE]" },
  // OpenAI-style API keys
  { label: "api-key", pattern: /\b(sk-[A-Za-z0-9]{20,}|pk-[A-Za-z0-9]{20,})\b/g, replacement: "[API-KEY]" },
  // Slack tokens
  { label: "slack-token", pattern: /\b(xox[baprs]-[A-Za-z0-9-]{20,})\b/g, replacement: "[SLACK-TOKEN]" },
  // Environment variable inline tokens
  { label: "env-token", pattern: /((?:BOT_TOKEN|WEIXIN_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|COOKIE|CODEX_WEIXIN_CONSOLE_TOKEN)=)([A-Za-z0-9._/+~=-]{8,})/g, replacement: "$1[REDACTED]" },
];

// ---------------------------------------------------------------------------
// Redaction function
// ---------------------------------------------------------------------------

/**
 * Redact sensitive values from a string.
 * Returns the redacted string and a count of redactions performed.
 */
export function redact(input: string): { text: string; count: number } {
  let text = String(input ?? "");
  let count = 0;

  for (const rule of REDACT_RULES) {
    const before = text;
    text = text.replace(rule.pattern, rule.replacement);
    if (text !== before) {
      count += 1;
    }
  }

  return { text, count };
}

/**
 * Convenience wrapper — returns just the redacted string.
 */
export function redactText(input: string): string {
  return redact(input).text;
}

// ---------------------------------------------------------------------------
// Log levels
// ---------------------------------------------------------------------------

export type LogLevel = "minimal" | "metadata" | "full-debug";

export interface LogEntry {
  hash: string;       // SHA-256 prefix of the original message
  level: LogLevel;
  pseudonym: string;  // stable pseudonym for the session
  status: string;     // "processed" | "failed" | "skipped" | "queued"
  timestamp: string;
  errorCategory?: string;
  durationMs?: number;
}

export function createLogEntry(params: {
  level: LogLevel;
  pseudonym: string;
  status: LogEntry["status"];
  errorCategory?: string;
  durationMs?: number;
}): LogEntry {
  return {
    hash: "",
    ...params,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Data retention cleanup
// ---------------------------------------------------------------------------

/**
 * Count of days before old data is eligible for cleanup.
 * Controlled by CODEX_WEIXIN_DATA_RETENTION_DAYS env var.
 */
export function isDataExpired(
  timestamp: string,
  retentionDays: number,
): boolean {
  const ageMs = Date.now() - new Date(timestamp).getTime();
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  return ageMs > retentionMs;
}
