import { describe, expect, it } from "vitest";
import { makeAccountHash, makePeerHash, makeMessageUid } from "../src/messageIdentity.js";

describe("messageIdentity", () => {
  describe("makeAccountHash", () => {
    it("produces a stable hash from an account ID", () => {
      const hash1 = makeAccountHash("account-123");
      const hash2 = makeAccountHash("account-123");
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(16);
      expect(hash1).toMatch(/^[a-f0-9]+$/);
    });

    it("produces different hashes for different accounts", () => {
      const hash1 = makeAccountHash("account-a");
      const hash2 = makeAccountHash("account-b");
      expect(hash1).not.toBe(hash2);
    });
  });

  describe("makePeerHash", () => {
    it("produces a stable hash from a peer ID", () => {
      const hash1 = makePeerHash("wxid_user123");
      const hash2 = makePeerHash("wxid_user123");
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(16);
    });

    it("does not contain the raw peer ID", () => {
      const hash = makePeerHash("wxid_secret123");
      expect(hash).not.toContain("wxid");
      expect(hash).not.toContain("secret123");
    });
  });

  describe("makeMessageUid", () => {
    it("uses message_id when available", () => {
      const uid = makeMessageUid({
        accountId: "acc-1",
        messageId: 12345,
      });
      expect(uid).toMatch(/^weixin:[a-f0-9]+:msg:12345$/);
    });

    it("uses account hash, not raw account ID", () => {
      const uid = makeMessageUid({
        accountId: "acc-1",
        messageId: 12345,
      });
      expect(uid).not.toContain("acc-1");
    });

    it("different accounts with same message_id produce different UIDs", () => {
      const uid1 = makeMessageUid({ accountId: "acc-a", messageId: 1 });
      const uid2 = makeMessageUid({ accountId: "acc-b", messageId: 1 });
      expect(uid1).not.toBe(uid2);
    });

    it("same account and same message_id produce same UID", () => {
      const uid1 = makeMessageUid({ accountId: "acc", messageId: 1 });
      const uid2 = makeMessageUid({ accountId: "acc", messageId: 1 });
      expect(uid1).toBe(uid2);
    });

    it("falls back to hash when no message_id", () => {
      const uid = makeMessageUid({
        accountId: "acc",
        fromUserId: "user1",
        createTimeMs: 1000,
        text: "hello",
      });
      expect(uid).toMatch(/^weixin:[a-f0-9]+:hash:/);
    });

    it("hash UID is deterministic for same inputs", () => {
      const uid1 = makeMessageUid({ accountId: "acc", fromUserId: "u1", createTimeMs: 1000, text: "hello" });
      const uid2 = makeMessageUid({ accountId: "acc", fromUserId: "u1", createTimeMs: 1000, text: "hello" });
      expect(uid1).toBe(uid2);
    });

    it("hash UID differs for different text", () => {
      const uid1 = makeMessageUid({ accountId: "acc", fromUserId: "u1", text: "hello" });
      const uid2 = makeMessageUid({ accountId: "acc", fromUserId: "u1", text: "world" });
      expect(uid1).not.toBe(uid2);
    });

    it("handles empty inputs gracefully", () => {
      const uid = makeMessageUid({ accountId: "" });
      expect(uid).toBeTruthy();
      expect(typeof uid).toBe("string");
    });
  });
});
