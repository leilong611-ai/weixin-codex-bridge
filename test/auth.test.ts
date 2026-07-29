import { describe, expect, it } from "vitest";

import {
  authorizePeer,
  canExecuteCodex,
  canUseOwnerCommand,
  canUseCommand,
  classifyCommand,
  resolvePeerRole,
  type PeerListConfig,
  type PeerRole,
} from "../src/auth.js";

function makeList(overrides: Partial<PeerListConfig> = {}): PeerListConfig {
  return {
    ownerPeerIds: ["owner1", "owner2"],
    allowedPeerIds: ["allowed1", "allowed2"],
    readonlyPeerIds: ["readonly1"],
    defaultDeny: true,
    ...overrides,
  };
}

describe("resolvePeerRole", () => {
  it("returns owner for configured owner peerIds", () => {
    expect(resolvePeerRole("owner1", makeList())).toBe("owner");
    expect(resolvePeerRole("owner2", makeList())).toBe("owner");
  });

  it("returns allowed for configured allowed peerIds", () => {
    expect(resolvePeerRole("allowed1", makeList())).toBe("allowed");
    expect(resolvePeerRole("allowed2", makeList())).toBe("allowed");
  });

  it("returns readonly for configured readonly peerIds", () => {
    expect(resolvePeerRole("readonly1", makeList())).toBe("readonly");
  });

  it("returns unknown for unlisted peerIds when defaultDeny=true", () => {
    expect(resolvePeerRole("unknown-user", makeList())).toBe("unknown");
    expect(resolvePeerRole("", makeList())).toBe("unknown");
    expect(resolvePeerRole("  ", makeList())).toBe("unknown");
  });

  it("returns owner over allowed when peer is in both lists", () => {
    const list = makeList({ ownerPeerIds: ["overlap"], allowedPeerIds: ["overlap"] });
    expect(resolvePeerRole("overlap", list)).toBe("owner");
  });
});

describe("authorizePeer", () => {
  it("returns the resolved role and peerId", () => {
    const result = authorizePeer("allowed1", makeList());
    expect(result).toEqual({ peerId: "allowed1", role: "allowed" });
  });

  it("returns unknown for strangers", () => {
    const result = authorizePeer("hacker", makeList());
    expect(result).toEqual({ peerId: "hacker", role: "unknown" });
  });
});

describe("classifyCommand", () => {
  it("marks owner-only commands", () => {
    expect(classifyCommand("诊断")).toEqual({ kind: "owner" });
    expect(classifyCommand("doctor")).toEqual({ kind: "owner" });
    expect(classifyCommand("代理")).toEqual({ kind: "owner" });
    expect(classifyCommand("清空失败")).toEqual({ kind: "owner" });
    expect(classifyCommand("归档失败")).toEqual({ kind: "owner" });
    expect(classifyCommand("clear failures")).toEqual({ kind: "owner" });
    expect(classifyCommand("丢弃 1")).toEqual({ kind: "owner" });
    expect(classifyCommand("取消")).toEqual({ kind: "owner" });
    expect(classifyCommand("对话")).toEqual({ kind: "owner" });
    expect(classifyCommand("对话 1")).toEqual({ kind: "owner" });
    expect(classifyCommand("对话 当前")).toEqual({ kind: "owner" });
    expect(classifyCommand("记录")).toEqual({ kind: "owner" });
    expect(classifyCommand("任务")).toEqual({ kind: "owner" });
    expect(classifyCommand("队列")).toEqual({ kind: "owner" });
    expect(classifyCommand("桌面模型5.4")).toEqual({ kind: "owner" });
  });

  it("marks allowed commands", () => {
    expect(classifyCommand("当前")).toEqual({ kind: "allowed" });
    expect(classifyCommand("current")).toEqual({ kind: "allowed" });
    expect(classifyCommand("状态")).toEqual({ kind: "allowed" });
    expect(classifyCommand("status")).toEqual({ kind: "allowed" });
    expect(classifyCommand("帮助")).toEqual({ kind: "allowed" });
    expect(classifyCommand("重试")).toEqual({ kind: "allowed" });
    expect(classifyCommand("重试 1")).toEqual({ kind: "allowed" });
    expect(classifyCommand("retry")).toEqual({ kind: "allowed" });
  });

  it("returns allowed for plain messages (not classified as command)", () => {
    expect(classifyCommand("你好 Codex")).toEqual({ kind: "allowed" });
    expect(classifyCommand("帮我写个方案")).toEqual({ kind: "allowed" });
  });
});

describe("canExecuteCodex", () => {
  it("allows owner and allowed", () => {
    expect(canExecuteCodex("owner")).toBe(true);
    expect(canExecuteCodex("allowed")).toBe(true);
  });

  it("blocks readonly and unknown", () => {
    expect(canExecuteCodex("readonly")).toBe(false);
    expect(canExecuteCodex("unknown")).toBe(false);
  });
});

describe("canUseOwnerCommand", () => {
  it("only allows owner", () => {
    expect(canUseOwnerCommand("owner")).toBe(true);
    expect(canUseOwnerCommand("allowed")).toBe(false);
    expect(canUseOwnerCommand("readonly")).toBe(false);
    expect(canUseOwnerCommand("unknown")).toBe(false);
  });
});

describe("canUseCommand", () => {
  it("owner can use any command", () => {
    expect(canUseCommand("owner", { kind: "owner" })).toBe(true);
    expect(canUseCommand("owner", { kind: "allowed" })).toBe(true);
    expect(canUseCommand("owner", { kind: "readonly" })).toBe(true);
  });

  it("allowed can use allowed and readonly commands but not owner", () => {
    expect(canUseCommand("allowed", { kind: "owner" })).toBe(false);
    expect(canUseCommand("allowed", { kind: "allowed" })).toBe(true);
    expect(canUseCommand("allowed", { kind: "readonly" })).toBe(true);
  });

  it("readonly can only use readonly commands", () => {
    expect(canUseCommand("readonly", { kind: "owner" })).toBe(false);
    expect(canUseCommand("readonly", { kind: "allowed" })).toBe(false);
    expect(canUseCommand("readonly", { kind: "readonly" })).toBe(true);
  });

  it("unknown cannot use any commands", () => {
    expect(canUseCommand("unknown", { kind: "owner" })).toBe(false);
    expect(canUseCommand("unknown", { kind: "allowed" })).toBe(false);
    expect(canUseCommand("unknown", { kind: "readonly" })).toBe(false);
  });
});
