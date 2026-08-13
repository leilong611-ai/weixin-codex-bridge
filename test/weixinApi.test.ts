import { describe, expect, it, vi } from "vitest";

import { WeixinApi } from "../src/weixinApi.js";
import { makeTestConfig } from "./testConfig.js";

describe("WeixinApi endpoint security", () => {
  it("rejects insecure or credential-bearing account endpoints", () => {
    const config = makeTestConfig(process.cwd());

    expect(() => new WeixinApi(config, {
      accountId: "example",
      baseUrl: "http://ilinkai.weixin.qq.com",
      token: "placeholder-token"
    })).toThrow("must use HTTPS");
    expect(() => new WeixinApi(config, {
      accountId: "example",
      baseUrl: "https://user:password@ilinkai.weixin.qq.com",
      token: "placeholder-token"
    })).toThrow("embedded credentials");
  });

  it("does not expose upstream response bodies in runtime errors", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ bot_token: "private-token", message: "private message text" }),
      { status: 500 }
    ));
    try {
      const api = new WeixinApi(makeTestConfig(process.cwd()), {
        accountId: "example",
        baseUrl: "https://ilinkai.weixin.qq.com",
        token: "placeholder-token"
      });
      let message = "";
      try {
        await api.sendText({ to: "placeholder-peer", text: "hello" });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe("sendMessage failed with HTTP 500.");
      expect(message).not.toContain("private-token");
      expect(message).not.toContain("private message text");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
