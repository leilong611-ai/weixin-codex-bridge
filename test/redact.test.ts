import { describe, expect, it } from "vitest";

import { redact, redactText, isDataExpired } from "../src/redact.js";

describe("redact", () => {
  it("redacts Bearer tokens in headers", () => {
    const input = 'Authorization: Bearer sk-abc123def456ghi789jkl012';
    const result = redact(input);
    expect(result.text).not.toContain("sk-abc123def456ghi789jkl012");
    expect(result.count).toBeGreaterThanOrEqual(1);
  });

  it("redacts API keys", () => {
    const input = "API key: sk-abcdefghijklmnopqrstuvwxyz123456";
    const result = redact(input);
    expect(result.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(result.count).toBeGreaterThanOrEqual(1);
  });

  it("redacts macOS user paths", () => {
    const input = "path: /Users/johndoe/projects";
    const result = redact(input);
    expect(result.text).toContain("/Users/[USER]");
    expect(result.text).not.toContain("johndoe");
  });

  it("redacts Windows user paths", () => {
    const input = 'path: "C:\\Users\\roy\\Documents"';
    const result = redact(input);
    expect(result.text).not.toContain("roy");
    expect(result.text).toContain("[USER]");
  });

  it("redacts email addresses", () => {
    const input = "email: test@example.com";
    const result = redact(input);
    expect(result.text).not.toContain("test@example.com");
    expect(result.text).toContain("[EMAIL]");
  });

  it("redacts Chinese phone numbers", () => {
    const input = "phone: 13800138000";
    const result = redact(input);
    expect(result.text).not.toContain("13800138000");
    expect(result.text).toContain("[PHONE]");
  });

  it("redacts WeChat wxid", () => {
    const input = "wxid_abcdef123456";
    const result = redact(input);
    expect(result.text).not.toContain("wxid_abcdef123456");
    expect(result.text).toContain("[WXID]");
  });

  it("redacts Slack tokens", () => {
    // Build the input programmatically to avoid GitHub secret scanning false positives
    const prefix = "xoxb";
    const input = prefix + "-123456789012-abcdefghijklmnopqrst";
    const result = redact(input);
    expect(result.text).not.toContain("xoxb-");
    expect(result.text).toContain("[SLACK-TOKEN]");
  });

  it("handles empty or non-string input gracefully", () => {
    expect(redact("").text).toBe("");
    expect(redact("safe text").text).toBe("safe text");
    expect(redact("safe text").count).toBe(0);
  });

  it("redacts env variable tokens", () => {
    const input = "BOT_TOKEN=mysecretkey123456789!";
    const result = redact(input);
    expect(result.text).not.toContain("mysecretkey123456789!");
    expect(result.text).toContain("[REDACTED]");
  });
});

describe("redactText", () => {
  it("returns the redacted string directly", () => {
    const result = redactText("/Users/testuser/docs");
    expect(result).toContain("/Users/[USER]");
    expect(result).not.toContain("testuser");
  });
});

describe("isDataExpired", () => {
  it("marks old timestamps as expired", () => {
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    expect(isDataExpired(old, 7)).toBe(true);
  });

  it("marks recent timestamps as not expired", () => {
    const recent = new Date().toISOString();
    expect(isDataExpired(recent, 7)).toBe(false);
  });
});
