import { describe, expect, it } from "vitest";

import { extractWeixinText } from "../src/weixinText.js";

describe("extractWeixinText", () => {
  it("returns plain WeChat text exactly", () => {
    const text = "你好  Codex\n第二行，保留空格";

    expect(extractWeixinText({
      item_list: [
        {
          type: 1,
          text_item: { text }
        }
      ]
    })).toBe(text);
  });

  it("uses voice transcript text when WeChat provides it", () => {
    expect(extractWeixinText({
      item_list: [
        {
          type: 3,
          voice_item: { text: "语音转文字内容" }
        }
      ]
    })).toBe("语音转文字内容");
  });

  it("includes quoted text context before the current reply text", () => {
    expect(extractWeixinText({
      item_list: [
        {
          type: 1,
          text_item: { text: "那就按这个改" },
          ref_msg: {
            title: "上一条",
            message_item: {
              type: 1,
              text_item: { text: "把 OpenClaw 替换掉" }
            }
          }
        }
      ]
    })).toBe("[引用: 上一条 | 把 OpenClaw 替换掉]\n那就按这个改");
  });

  it("returns an empty string when there is no text-like payload", () => {
    expect(extractWeixinText({
      item_list: [
        {
          type: 2,
          image_item: {}
        }
      ]
    })).toBe("");
  });
});
