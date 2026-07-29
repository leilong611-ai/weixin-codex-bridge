import { describe, expect, it } from "vitest";

import { createSessionKey } from "../src/sessionKey.js";

describe("createSessionKey", () => {
  it("creates a stable filesystem-safe key for an account and peer", () => {
    const first = createSessionKey("7d493b002392-im-bot", "roy@example@im.wechat");
    const second = createSessionKey("7d493b002392-im-bot", "roy@example@im.wechat");

    expect(first).toBe(second);
    expect(first).toMatch(/^weixin_[A-Za-z0-9._-]+$/);
    expect(first).not.toContain("@");
    expect(first).not.toContain(":");
    expect(first).not.toContain("\\");
    expect(first).not.toContain("/");
  });

  it("separates different peers", () => {
    expect(createSessionKey("account", "a@im.wechat")).not.toBe(createSessionKey("account", "b@im.wechat"));
  });
});
