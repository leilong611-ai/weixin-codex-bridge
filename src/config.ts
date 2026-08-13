import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { findLatestDesktopSessionId } from "./codexSession.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface BridgeConfig {
  accountId?: string;
  allowUnconfiguredDevMode: boolean;
  autoDesktopSession: boolean;
  cliFallbackEnabled: boolean;
  codexCmdPath: string;
  codexCwd: string;
  codexHome: string;
  codexModel?: string;
  codexSessionId?: string;
  consoleEnabled: boolean;
  consolePort: number;
  consoleToken: string;
  deliveryMode: "desktop-ui" | "codex-cli";
  desktopInputScriptPath: string;
  desktopModelScriptPath: string;
  desktopResponseTimeoutMs: number;
  logRoot: string;
  maxParallelRuns: number;
  openclawConfigPath: string;
  openclawStateRoot: string;
  ownerPeerIds: string[];
  allowedPeerIds: string[];
  readonlyPeerIds: string[];
  defaultDeny: boolean;
  pollTimeoutMs: number;
  resumeAllSessions: boolean;
  resumeLast: boolean;
  skipBacklogOnStart: boolean;
  weixinChannelVersion: string;
  sandboxRoot: string;
  allowedWorkspaceRoots: string[];
  executionMode: "restricted" | "high-risk";
  allowFullAuto: boolean;
  allowSkipGitCheck: boolean;
  logLevel: "minimal" | "metadata" | "full-debug";
  transcriptEnabled: boolean;
  storeFullPrompts: boolean;
  dataRetentionDays: number;
}

function boolEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function numberEnv(name: string, defaultValue: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : defaultValue;
}

function configuredRootEnv(name: string): string | undefined {
  const raw = process.env[name];
  return raw == null || raw.trim() === "" ? undefined : raw;
}

function defaultBridgeStateRoot(home: string): string {
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
      "codex-weixin-bridge"
    );
  }

  return path.join(home, ".local", "state", "codex-weixin-bridge");
}

function parseListEnv(name: string): string[] {
  const raw = process.env[name];
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadBridgeConfig(): BridgeConfig {
  const home = os.homedir();
  const openclawStateRoot = process.env.OPENCLAW_STATE_DIR ??
    path.join(home, ".openclaw");
  const bridgeStateRoot = configuredRootEnv("CODEX_WEIXIN_LOG_ROOT") ??
    configuredRootEnv("CODEX_WEIXIN_STATE_ROOT") ??
    defaultBridgeStateRoot(home);
  const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
  const defaultCodexCommand = process.platform === "win32"
    ? path.join(appData, "npm", "codex.cmd")
    : "codex";
  const codexHome = process.env.CODEX_HOME ?? path.join(home, ".codex");
  const codexCwd = process.env.CODEX_WEIXIN_CWD ?? process.cwd();
  const autoDesktopSession = boolEnv("CODEX_WEIXIN_AUTO_DESKTOP_SESSION", true);
  const deliveryMode = process.env.CODEX_WEIXIN_DELIVERY_MODE === "codex-cli" ? "codex-cli" : "desktop-ui";
  const codexSessionId = process.env.CODEX_WEIXIN_SESSION_ID ??
    (autoDesktopSession ? findLatestDesktopSessionId({ codexHome, codexCwd }) : undefined);
  const maxParallelRuns = deliveryMode === "desktop-ui"
    ? 1
    : numberEnv("CODEX_WEIXIN_MAX_PARALLEL", 3);

  // ---- security defaults ----
  const consoleToken = configuredRootEnv("CODEX_WEIXIN_CONSOLE_TOKEN")
    ?? randomBytes(32).toString("hex");

  return {
    accountId: process.env.CODEX_WEIXIN_ACCOUNT_ID,
    allowUnconfiguredDevMode: boolEnv("CODEX_WEIXIN_ALLOW_UNCONFIGURED_DEV_MODE", false),
    autoDesktopSession,
    cliFallbackEnabled: boolEnv("CODEX_WEIXIN_CLI_FALLBACK", false),
    codexCmdPath: process.env.CODEX_CMD_PATH ?? defaultCodexCommand,
    codexCwd,
    codexHome,
    codexModel: process.env.CODEX_WEIXIN_MODEL ?? "gpt-5.4-mini",
    codexSessionId,
    consoleEnabled: boolEnv("CODEX_WEIXIN_CONSOLE_ENABLED", false),
    consolePort: numberEnv("CODEX_WEIXIN_CONSOLE_PORT", 18790),
    consoleToken,
    deliveryMode,
    desktopInputScriptPath: process.env.CODEX_WEIXIN_DESKTOP_INPUT_SCRIPT ??
      path.join(PACKAGE_ROOT, "scripts", "Send-CodexDesktopInput.ps1"),
    desktopModelScriptPath: process.env.CODEX_WEIXIN_DESKTOP_MODEL_SCRIPT ??
      path.join(PACKAGE_ROOT, "scripts", "Set-CodexDesktopModel.ps1"),
    desktopResponseTimeoutMs: numberEnv("CODEX_WEIXIN_DESKTOP_RESPONSE_TIMEOUT_MS", 900_000),
    logRoot: bridgeStateRoot,
    maxParallelRuns,
    openclawConfigPath: process.env.OPENCLAW_CONFIG_PATH ??
      path.join(openclawStateRoot, "openclaw.json"),
    openclawStateRoot,
    ownerPeerIds: parseListEnv("CODEX_WEIXIN_OWNER_PEER_IDS"),
    allowedPeerIds: parseListEnv("CODEX_WEIXIN_ALLOWED_PEER_IDS"),
    readonlyPeerIds: parseListEnv("CODEX_WEIXIN_READONLY_PEER_IDS"),
    defaultDeny: boolEnv("CODEX_WEIXIN_DEFAULT_DENY", true),
    sandboxRoot: configuredRootEnv("CODEX_WEIXIN_SANDBOX_ROOT") ?? "",
    allowedWorkspaceRoots: parseListEnv("CODEX_WEIXIN_ALLOWED_WORKSPACE_ROOTS"),
    executionMode: process.env.CODEX_WEIXIN_EXECUTION_MODE === "high-risk" ? "high-risk" : "restricted",
    allowFullAuto: boolEnv("CODEX_WEIXIN_ALLOW_FULL_AUTO", false),
    allowSkipGitCheck: boolEnv("CODEX_WEIXIN_ALLOW_SKIP_GIT_CHECK", false),
    logLevel: (process.env.CODEX_WEIXIN_LOG_LEVEL as "minimal" | "metadata" | "full-debug") ?? "minimal",
    transcriptEnabled: boolEnv("CODEX_WEIXIN_TRANSCRIPT_ENABLED", false),
    storeFullPrompts: boolEnv("CODEX_WEIXIN_STORE_FULL_PROMPTS", false),
    dataRetentionDays: numberEnv("CODEX_WEIXIN_DATA_RETENTION_DAYS", 7),
    pollTimeoutMs: numberEnv("CODEX_WEIXIN_POLL_TIMEOUT_MS", 35_000),
    resumeAllSessions: boolEnv("CODEX_WEIXIN_RESUME_ALL", true),
    resumeLast: boolEnv("CODEX_WEIXIN_RESUME_LAST", true),
    skipBacklogOnStart: boolEnv("CODEX_WEIXIN_SKIP_BACKLOG_ON_START", true),
    weixinChannelVersion: process.env.CODEX_WEIXIN_CHANNEL_VERSION ?? "2.1.1",
  };
}
