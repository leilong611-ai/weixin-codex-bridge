import { describe, expect, it } from "vitest";

import {
  checkConsoleSecurity,
  validateConsoleToken,
  validateConsoleOrigin,
  validateCsrfToken,
  validateConsoleContentType,
  checkRateLimit,
  MAX_CONSOLE_BODY_BYTES,
} from "../src/consoleAuth.js";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";

function makeRequest(headers: Record<string, string | undefined>, method = "GET"): IncomingMessage {
  const socket = new Socket();
  // Node 22+ remoteAddress is getter-only; we rely on rate limiting
  // falling back to "127.0.0.1" from socket.remoteAddress which is undefined.
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = "/api/status";
  // Set headers via internal property
  for (const [key, value] of Object.entries(headers)) {
    req.headers[key.toLowerCase()] = value;
  }
  return req;
}

const EXPECTED_TOKEN = "test-console-token-32bytes!";

describe("validateConsoleToken", () => {
  it("rejects missing Authorization header", () => {
    const req = makeRequest({});
    const result = validateConsoleToken(req, EXPECTED_TOKEN);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Missing");
  });

  it("rejects wrong Authorization scheme", () => {
    const req = makeRequest({ authorization: "Basic dGVzdA==" });
    const result = validateConsoleToken(req, EXPECTED_TOKEN);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Bearer");
  });

  it("rejects wrong token", () => {
    const req = makeRequest({ authorization: "Bearer wrong-token" });
    const result = validateConsoleToken(req, EXPECTED_TOKEN);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Invalid");
  });

  it("accepts correct token", () => {
    const req = makeRequest({ authorization: `Bearer ${EXPECTED_TOKEN}` });
    const result = validateConsoleToken(req, EXPECTED_TOKEN);
    expect(result.ok).toBe(true);
  });
});

describe("validateConsoleOrigin", () => {
  it("rejects external origins", () => {
    const req = makeRequest({ origin: "https://evil.com" });
    const result = validateConsoleOrigin(req);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Origin");
  });

  it("accepts localhost origin", () => {
    const req = makeRequest({ origin: "http://127.0.0.1:18790" });
    const result = validateConsoleOrigin(req);
    expect(result.ok).toBe(true);
  });

  it("rejects external Host", () => {
    const req = makeRequest({ host: "evil.com:80" });
    const result = validateConsoleOrigin(req);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Host");
  });

  it("accepts local Host", () => {
    const req = makeRequest({ host: "127.0.0.1:18790" });
    const result = validateConsoleOrigin(req);
    expect(result.ok).toBe(true);
  });
});

describe("validateCsrfToken", () => {
  it("skips CSRF check for GET", () => {
    const req = makeRequest({}, "GET");
    const result = validateCsrfToken(req);
    expect(result.ok).toBe(true);
  });

  it("rejects POST without CSRF token", () => {
    const req = makeRequest({ "content-type": "application/json" }, "POST");
    const result = validateCsrfToken(req);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("CSRF");
  });

  it("accepts POST with correct CSRF token", () => {
    const req = makeRequest({
      "content-type": "application/json",
      "x-csrf-token": "console-1",
    }, "POST");
    const result = validateCsrfToken(req);
    expect(result.ok).toBe(true);
  });
});

describe("validateConsoleContentType", () => {
  it("skips Content-Type check for GET", () => {
    const req = makeRequest({}, "GET");
    const result = validateConsoleContentType(req);
    expect(result.ok).toBe(true);
  });

  it("rejects POST without JSON Content-Type", () => {
    const req = makeRequest({ "content-type": "text/plain" }, "POST");
    const result = validateConsoleContentType(req);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Content-Type");
  });

  it("accepts POST with application/json", () => {
    const req = makeRequest({ "content-type": "application/json" }, "POST");
    const result = validateConsoleContentType(req);
    expect(result.ok).toBe(true);
  });
});

describe("checkRateLimit", () => {
  it("allows requests under limit", () => {
    expect(checkRateLimit("1.2.3.4").ok).toBe(true);
    expect(checkRateLimit("1.2.3.4").ok).toBe(true);
  });
});

describe("checkConsoleSecurity (integration)", () => {
  it("rejects request without token", () => {
    const req = makeRequest({});
    const result = checkConsoleSecurity(req, EXPECTED_TOKEN);
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(401);
  });

  it("rejects with wrong token", () => {
    const req = makeRequest({ authorization: "Bearer wrong-token" });
    const result = checkConsoleSecurity(req, EXPECTED_TOKEN);
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(401);
  });

  it("rejects POST without CSRF token even with valid auth", () => {
    const req = makeRequest({
      authorization: `Bearer ${EXPECTED_TOKEN}`,
      "content-type": "application/json",
    }, "POST");
    const result = checkConsoleSecurity(req, EXPECTED_TOKEN);
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(403);
  });

  it("accepts well-formed request with valid auth", () => {
    const req = makeRequest({
      authorization: `Bearer ${EXPECTED_TOKEN}`,
      "content-type": "application/json",
      "x-csrf-token": "console-1",
    }, "POST");
    const result = checkConsoleSecurity(req, EXPECTED_TOKEN);
    expect(result.ok).toBe(true);
  });

  it("rejects external origin even with valid token", () => {
    const req = makeRequest({
      authorization: `Bearer ${EXPECTED_TOKEN}`,
      origin: "https://evil.com",
    });
    const result = checkConsoleSecurity(req, EXPECTED_TOKEN);
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(403);
  });
});

describe("MAX_CONSOLE_BODY_BYTES", () => {
  it("has a reasonable body size limit", () => {
    expect(MAX_CONSOLE_BODY_BYTES).toBe(128 * 1024);
    expect(MAX_CONSOLE_BODY_BYTES).toBeGreaterThan(0);
  });
});
