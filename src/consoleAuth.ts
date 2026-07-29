/**
 * Console server security: authentication, CSRF, origin validation.
 */

import type { IncomingMessage } from "node:http";

export interface ConsoleAuthResult {
  ok: boolean;
  reason: string;
}

// ---------------------------------------------------------------------------
// Token validation
// ---------------------------------------------------------------------------

/**
 * Validate the Authorization: Bearer token from an HTTP request.
 */
export function validateConsoleToken(
  request: IncomingMessage,
  expectedToken: string,
): ConsoleAuthResult {
  const authHeader = request.headers.authorization;

  if (!authHeader) {
    return { ok: false, reason: "Missing Authorization header." };
  }

  const parts = authHeader.split(/\s+/);
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") {
    return { ok: false, reason: "Authorization header must be: Bearer <token>" };
  }

  const token = parts[1] ?? "";
  if (!token) {
    return { ok: false, reason: "Authorization token is empty." };
  }

  // Constant-time comparison
  if (token.length !== expectedToken.length) {
    return { ok: false, reason: "Invalid token." };
  }

  let match = 0;
  for (let i = 0; i < token.length; i++) {
    match |= token.charCodeAt(i) ^ expectedToken.charCodeAt(i);
  }

  if (match !== 0) {
    return { ok: false, reason: "Invalid token." };
  }

  return { ok: true, reason: "ok" };
}

// ---------------------------------------------------------------------------
// Origin / Host validation
// ---------------------------------------------------------------------------

export function validateConsoleOrigin(request: IncomingMessage): ConsoleAuthResult {
  const origin = request.headers.origin;
  const host = request.headers.host;

  // Block requests with an origin that doesn't match localhost
  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (
        originUrl.hostname !== "127.0.0.1" &&
        originUrl.hostname !== "localhost" &&
        originUrl.hostname !== "[::1]"
      ) {
        return { ok: false, reason: `Origin not allowed: ${origin}` };
      }
    } catch {
      return { ok: false, reason: `Invalid Origin header: ${origin}` };
    }
  }

  // Host header should be localhost:port or 127.0.0.1:port
  if (host) {
    const hostParts = host.split(":");
    const hostname = hostParts[0] ?? "";
    if (
      hostname !== "127.0.0.1" &&
      hostname !== "localhost" &&
      hostname !== "[::1]"
    ) {
      return { ok: false, reason: `Host not allowed: ${host}` };
    }
  }

  return { ok: true, reason: "ok" };
}

// ---------------------------------------------------------------------------
// CSRF token validation (double-submit cookie pattern)
// ---------------------------------------------------------------------------

/**
 * Simple CSRF protection using a custom header.
 * The frontend JS sets X-CSRF-Token to a known value.
 */
export function validateCsrfToken(request: IncomingMessage): ConsoleAuthResult {
  // GET, HEAD, OPTIONS requests are safe by definition
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
    return { ok: true, reason: "ok" };
  }

  const csrfHeader = request.headers["x-csrf-token"];
  if (!csrfHeader) {
    return { ok: false, reason: "Missing X-CSRF-Token header." };
  }

  // A simple presence check — the real protection is that no external site
  // can read the console's bearer token to set this header.
  if (csrfHeader !== "console-1") {
    return { ok: false, reason: "Invalid CSRF token." };
  }

  return { ok: true, reason: "ok" };
}

// ---------------------------------------------------------------------------
// Content-Type validation
// ---------------------------------------------------------------------------

export function validateConsoleContentType(request: IncomingMessage): ConsoleAuthResult {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
    return { ok: true, reason: "ok" };
  }

  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.includes("application/json")) {
    return { ok: false, reason: "Content-Type must be application/json." };
  }

  return { ok: true, reason: "ok" };
}

// ---------------------------------------------------------------------------
// Request body size limit
// ---------------------------------------------------------------------------

export const MAX_CONSOLE_BODY_BYTES = 128 * 1024; // 128 KB

// ---------------------------------------------------------------------------
// Rate limiting (simple in-memory token bucket per IP)
// ---------------------------------------------------------------------------

interface RateBucket {
  count: number;
  resetAt: number;
}

const rateBuckets = new Map<string, RateBucket>();
const RATE_LIMIT = 60; // requests
const RATE_WINDOW_MS = 60_000; // per minute

export function checkRateLimit(clientIp: string): ConsoleAuthResult {
  const now = Date.now();
  const bucket = rateBuckets.get(clientIp);

  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(clientIp, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { ok: true, reason: "ok" };
  }

  bucket.count += 1;
  if (bucket.count > RATE_LIMIT) {
    return { ok: false, reason: "Rate limit exceeded. Try again later." };
  }

  return { ok: true, reason: "ok" };
}

// ---------------------------------------------------------------------------
// Combined middleware
// ---------------------------------------------------------------------------

export interface ConsoleSecurityResult {
  ok: boolean;
  reason: string;
  statusCode: number;
}

/**
 * Run all console security checks for a request.
 * Returns the first failure, or ok=true if all pass.
 */
export function checkConsoleSecurity(
  request: IncomingMessage,
  expectedToken: string,
): ConsoleSecurityResult {
  // 1. Rate limit
  const clientIp = request.socket.remoteAddress ?? "127.0.0.1";
  const rateResult = checkRateLimit(clientIp);
  if (!rateResult.ok) {
    return { ok: false, reason: rateResult.reason, statusCode: 429 };
  }

  // 2. Token
  const tokenResult = validateConsoleToken(request, expectedToken);
  if (!tokenResult.ok) {
    return { ok: false, reason: tokenResult.reason, statusCode: 401 };
  }

  // 3. Origin
  const originResult = validateConsoleOrigin(request);
  if (!originResult.ok) {
    return { ok: false, reason: originResult.reason, statusCode: 403 };
  }

  // 4. CSRF for mutating requests
  const csrfResult = validateCsrfToken(request);
  if (!csrfResult.ok) {
    return { ok: false, reason: csrfResult.reason, statusCode: 403 };
  }

  // 5. Content-Type for POST/PUT
  const ctResult = validateConsoleContentType(request);
  if (!ctResult.ok) {
    return { ok: false, reason: ctResult.reason, statusCode: 415 };
  }

  return { ok: true, reason: "ok", statusCode: 200 };
}
