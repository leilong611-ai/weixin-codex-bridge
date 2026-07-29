/**
 * Authorization module for Weixin Codex Bridge.
 *
 * Trust boundaries:
 *   WeChat peer → Weixin Bot API → Bridge process → Codex Desktop/CLI
 *
 * Every WeChat peerId MUST pass through authorizePeer() before any
 * prompt reaches Codex or any local command is executed.
 *
 * Roles (strictly ordered):
 *   owner      — full access (status, diagnostics, session management,
 *                model switching, workspace config, global task management)
 *   allowed    — only send normal messages to their own session
 *   readonly   — only read public status, never trigger Codex
 *   unknown    — all requests denied with a generic refusal
 */

import type { BridgeConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Role types
// ---------------------------------------------------------------------------

export type PeerRole = "owner" | "allowed" | "readonly" | "unknown";

// ---------------------------------------------------------------------------
// Commands and their minimum required role
// ---------------------------------------------------------------------------

/**
 * Every bridge command must be listed here with the minimum role required.
 *
 * "none" means the command is never routed to Codex and returns a generic
 * refusal for unknown users.  "public" means readonly can also see it.
 */
export type CommandAccess =
  | { readonly kind: "owner" }
  | { readonly kind: "allowed" }
  | { readonly kind: "readonly" }
  | { readonly kind: "deny" };

export function classifyCommand(text: string): CommandAccess {
  const trimmed = text.trim().toLowerCase().replace(/^\/+/, "");

  // ---------- owner only ----------
  const ownerPatterns = [
    /^(?:诊断|doctor|diagnose)$/,
    /^(?:代理|agents)$/,
    /^(?:桌面模型|desktop\s*model)/,
    /^(?:任务|队列|tasks|queue)$/,
    /^清空失败$/,
    /^归档失败$/,
    /^(?:clear\s+failures|clear\s+failed)$/,
    /^(?:archive\s+failures|archive\s+failed)$/,
    /^(?:丢弃|discard)\s+\d+$/,
    /^(?:取消|cancel)$/,
    /^(?:对话|会话)$/,
    /^(?:对话|会话)\s+\d+$/,
    /^(?:对话|会话)\s+(?:当前|current)$/,
    /^(?:对话|会话)\s*(?:当前|current)\s+/,
    /^(?:记录|记录|微信记录|history|records)/,
  ];
  for (const p of ownerPatterns) {
    if (p.test(trimmed)) return { kind: "owner" };
  }

  // ---------- allowed ----------
  const allowedPatterns = [
    /^(?:当前|current)$/,
    /^(?:状态|status)$/,
    /^(?:帮助|help)$/,
    /^(?:重试|retry)(?:\s+\d+)?$/,
  ];
  for (const p of allowedPatterns) {
    if (p.test(trimmed)) return { kind: "allowed" };
  }

  // ---------- readonly ----------
  const readonlyPatterns = [
    /^(?:状态|status)$/,
    /^(?:帮助|help)$/,
  ];
  for (const p of readonlyPatterns) {
    if (p.test(trimmed)) return { kind: "readonly" };
  }

  // Anything not classified is a plain message – requires at least "allowed".
  // The caller decides whether it's a command or a plain prompt.
  return { kind: "allowed" };
}

// ---------------------------------------------------------------------------
// Peer role resolution
// ---------------------------------------------------------------------------

export interface PeerListConfig {
  /** The peerId(s) that have owner role — at least one is required at startup. */
  ownerPeerIds: string[];
  /** PeerId(s) that can send normal messages. */
  allowedPeerIds: string[];
  /** PeerId(s) that can only query public status. */
  readonlyPeerIds: string[];
  /** If true, any peerId not in any list is rejected (default: true). */
  defaultDeny: boolean;
}

export function resolvePeerListFromEnv(env: NodeJS.ProcessEnv): PeerListConfig {
  const parseList = (key: string): string[] =>
    (env[key] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  return {
    ownerPeerIds: parseList("CODEX_WEIXIN_OWNER_PEER_IDS"),
    allowedPeerIds: parseList("CODEX_WEIXIN_ALLOWED_PEER_IDS"),
    readonlyPeerIds: parseList("CODEX_WEIXIN_READONLY_PEER_IDS"),
    defaultDeny: env.CODEX_WEIXIN_DEFAULT_DENY !== "false",
  };
}

export function resolvePeerRole(
  peerId: string,
  list: PeerListConfig,
): PeerRole {
  if (list.ownerPeerIds.includes(peerId)) return "owner";
  if (list.allowedPeerIds.includes(peerId)) return "allowed";
  if (list.readonlyPeerIds.includes(peerId)) return "readonly";
  return "unknown";
}

export interface PeerAuthorization {
  peerId: string;
  role: PeerRole;
}

/**
 * Authorize a WeChat peer against the configured allowlist.
 * Returns the resolved PeerAuthorization with role.
 * Does NOT throw — callers must check role before executing any action.
 */
export function authorizePeer(
  peerId: string,
  list: PeerListConfig,
): PeerAuthorization {
  return {
    peerId,
    role: resolvePeerRole(peerId, list),
  };
}

export function canExecuteCodex(role: PeerRole): boolean {
  return role === "owner" || role === "allowed";
}

export function canUseOwnerCommand(role: PeerRole): boolean {
  return role === "owner";
}

export function canUseCommand(role: PeerRole, access: CommandAccess): boolean {
  switch (access.kind) {
    case "owner":
      return role === "owner";
    case "allowed":
      return role === "owner" || role === "allowed";
    case "readonly":
      return role === "owner" || role === "allowed" || role === "readonly";
    case "deny":
      return false;
  }
}

// ---------------------------------------------------------------------------
// Refusal message (never leak internal state)
// ---------------------------------------------------------------------------

export const REFUSAL_MESSAGE =
  "抱歉，这条消息无法处理。如果你有使用权限，请联系管理员添加你的微信 ID 到白名单。";

// ---------------------------------------------------------------------------
// Startup guard
// ---------------------------------------------------------------------------

export function requireAuthorizedStartup(config: BridgeConfig): void {
  if (
    config.ownerPeerIds.length === 0 &&
    !config.allowUnconfiguredDevMode
  ) {
    throw new Error(
      [
        "CODEX_WEIXIN_OWNER_PEER_IDS is empty. The bridge will refuse ALL",
        "WeChat users until at least one owner peerId is configured.",
        "",
        "To run in an isolated dev environment without real WeChat peers,",
        "set CODEX_WEIXIN_ALLOW_UNCONFIGURED_DEV_MODE=true and ensure the",
        "bridge is not exposed to any network.",
      ].join("\n"),
    );
  }
}
