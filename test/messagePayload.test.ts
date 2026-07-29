import { describe, expect, it } from "vitest";
import {
  preparePayload,
  scrubPayload,
  scrubFailedPayload,
  payloadForRole,
  shouldStoreMessage,
  MAX_MESSAGE_BYTES,
} from "../src/messagePayload.js";

describe("messagePayload", () => {
  describe("preparePayload", () => {
    it("includes rawJson only in full-debug mode", () => {
      const p = preparePayload('{"secret":"data"}', "hello", 1, false, "minimal");
      expect(p.rawJson).toBe("");
      expect(p.text).toBe("hello");
    });

    it("includes rawJson in full-debug mode", () => {
      const p = preparePayload('{"data":"test"}', "hello", 1, false, "full-debug");
      expect(p.rawJson).toBe('{"data":"test"}');
      expect(p.text).toBe("hello");
    });

    it("truncates oversized text", () => {
      const longText = "x".repeat(MAX_MESSAGE_BYTES + 100);
      const p = preparePayload("{}", longText, 1, false, "full-debug");
      expect(p.text.length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    });

    it("marks bot messages", () => {
      const p = preparePayload("{}", "hi", 2, true, "minimal");
      expect(p.isBot).toBe(true);
      expect(p.messageType).toBe(2);
    });
  });

  describe("payloadForRole", () => {
    it("stores content for owner", () => {
      const result = payloadForRole("owner", { rawJson: '{"a":1}', text: "hi", messageType: 1, isBot: false });
      expect(result.rawJson).toBe('{"a":1}');
      expect(result.text).toBe("hi");
    });

    it("stores content for allowed", () => {
      const result = payloadForRole("allowed", { rawJson: '{"a":1}', text: "hi", messageType: 1, isBot: false });
      expect(result.rawJson).toBe('{"a":1}');
      expect(result.text).toBe("hi");
    });

    it("strips content for unknown users", () => {
      const result = payloadForRole("unknown", { rawJson: '{"a":1}', text: "secret", messageType: 1, isBot: false });
      expect(result.rawJson).toBe("");
      expect(result.text).toBe("");
    });

    it("strips content for readonly role", () => {
      const result = payloadForRole("readonly", { rawJson: '{"a":1}', text: "secret", messageType: 1, isBot: false });
      expect(result.rawJson).toBe("");
      expect(result.text).toBe("");
    });
  });

  describe("shouldStoreMessage", () => {
    it("returns false for bot messages", () => {
      expect(shouldStoreMessage({ rawJson: "{}", text: "hi", messageType: 2, isBot: true })).toBe(false);
    });

    it("returns false for empty payload", () => {
      expect(shouldStoreMessage({ rawJson: "", text: "", messageType: 1, isBot: false })).toBe(false);
    });

    it("returns true for valid user messages", () => {
      expect(shouldStoreMessage({ rawJson: "{}", text: "hi", messageType: 1, isBot: false })).toBe(true);
    });
  });

  describe("scrubPayload", () => {
    it("returns empty object", () => {
      expect(scrubPayload()).toEqual({});
    });
  });

  describe("scrubFailedPayload", () => {
    it("truncates long text", () => {
      const long = "x".repeat(3000);
      const result = scrubFailedPayload(long);
      expect(result.text!.length).toBe(2000);
    });

    it("preserves short text", () => {
      const result = scrubFailedPayload("short error");
      expect(result.text).toBe("short error");
    });
  });
});
