import { describe, expect, it } from "vitest";

import { buildCodexPrompt } from "../src/codexPrompt.js";

describe("buildCodexPrompt", () => {
  it("passes the WeChat text into Codex without metadata or decoration", () => {
    const text = "  微信里原样发送的内容\n第二行  ";

    expect(buildCodexPrompt(text)).toBe(text);
  });
});
