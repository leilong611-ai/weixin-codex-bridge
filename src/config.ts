import os from "node:os";
import path from "node:path";

import { findLatestDesktopSessionId } from "./codexSession.js";

export interface BridgeConfig {
  accountId?: string;
  autoDesktopSession: boolean;
  codexCmdPath: string;
  codexCwd: string;
  codexHome: string;
  codexModel?: string;
  codexSessionId?: string;
  cliFallbackEnabled: boolean;
  consoleEnabled: boolean;
  consolePort: number;
  deliveryMode: "desktop-ui" | "codex-cli";
  desktopInputScriptPath: string;
  desktopModelScriptPath: string;
  desktopResponseTimeoutMs: number;
  logRoot: string;
  maxParallelRuns: number;
  openclawConfigPath: string;
  openclawStateRoot: string;
  pollTimeoutMs: number;
  resumeAllSessions: boolean;
  resumeLast: boolean;
  skipBacklogOnStart: boolean;
  weixinChannelVersion: string;
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

export function loadBridgeConfig(): BridgeConfig {
  const home = os.homedir();
  const openclawStateRoot = process.env.OPENCLAW_STATE_DIR ??
    path.join(home, ".openclaw");
  const bridgeStateRoot = configuredRootEnv("CODEX_WEIXIN_LOG_ROOT") ??
    configuredRootEnv("CODEX_WEIXIN_STATE_ROOT") ??
    defaultBridgeStateRoot(home);
  const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
  const codexHome = process.env.CODEX_HOME ?? path.join(home, ".codex");
  const codexCwd = process.env.CODEX_WEIXIN_CWD ?? process.cwd();
  const autoDesktopSession = boolEnv("CODEX_WEIXIN_AUTO_DESKTOP_SESSION", true);
  const deliveryMode = process.env.CODEX_WEIXIN_DELIVERY_MODE === "codex-cli" ? "codex-cli" : "desktop-ui";
  const codexSessionId = process.env.CODEX_WEIXIN_SESSION_ID ??
    (autoDesktopSession ? findLatestDesktopSessionId({ codexHome, codexCwd }) : undefined);
  const maxParallelRuns = deliveryMode === "desktop-ui"
    ? 1
    : numberEnv("CODEX_WEIXIN_MAX_PARALLEL", 3);

  return {
    accountId: process.env.CODEX_WEIXIN_ACCOUNT_ID,
    autoDesktopSession,
    codexCmdPath: process.env.CODEX_CMD_PATH ?? path.join(appData, "npm", "codex.cmd"),
    codexCwd,
    codexHome,
    codexModel: process.env.CODEX_WEIXIN_MODEL ?? "gpt-5.4-mini",
    codexSessionId,
    cliFallbackEnabled: boolEnv("CODEX_WEIXIN_CLI_FALLBACK", false),
    consoleEnabled: boolEnv("CODEX_WEIXIN_CONSOLE_ENABLED", true),
    consolePort: numberEnv("CODEX_WEIXIN_CONSOLE_PORT", 18790),
    deliveryMode,
    desktopInputScriptPath: process.env.CODEX_WEIXIN_DESKTOP_INPUT_SCRIPT ??
      path.join(process.cwd(), "scripts", "Send-CodexDesktopInput.ps1"),
    desktopModelScriptPath: process.env.CODEX_WEIXIN_DESKTOP_MODEL_SCRIPT ??
      path.join(process.cwd(), "scripts", "Set-CodexDesktopModel.ps1"),
    desktopResponseTimeoutMs: numberEnv("CODEX_WEIXIN_DESKTOP_RESPONSE_TIMEOUT_MS", 900_000),
    logRoot: bridgeStateRoot,
    maxParallelRuns,
    openclawConfigPath: process.env.OPENCLAW_CONFIG_PATH ??
      path.join(openclawStateRoot, "openclaw.json"),
    openclawStateRoot,
    pollTimeoutMs: numberEnv("CODEX_WEIXIN_POLL_TIMEOUT_MS", 35_000),
    resumeAllSessions: boolEnv("CODEX_WEIXIN_RESUME_ALL", true),
    resumeLast: boolEnv("CODEX_WEIXIN_RESUME_LAST", true),
    skipBacklogOnStart: boolEnv("CODEX_WEIXIN_SKIP_BACKLOG_ON_START", true),
    weixinChannelVersion: process.env.CODEX_WEIXIN_CHANNEL_VERSION ?? "2.1.1"
  };
}
