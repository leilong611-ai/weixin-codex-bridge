import path from "node:path";

import type { BridgeConfig } from "../src/config.js";

export function makeTestConfig(
  root: string,
  overrides: Partial<BridgeConfig> = {}
): BridgeConfig {
  return {
    accountId: undefined,
    allowUnconfiguredDevMode: true,
    allowedPeerIds: [],
    allowedWorkspaceRoots: [],
    allowFullAuto: false,
    allowSkipGitCheck: false,
    autoDesktopSession: false,
    cliFallbackEnabled: false,
    codexCmdPath: path.join(root, "codex"),
    codexCwd: root,
    codexHome: path.join(root, ".codex"),
    codexModel: "gpt-5.4-mini",
    codexSessionId: undefined,
    consoleEnabled: false,
    consolePort: 18790,
    consoleToken: "placeholder-console-token",
    dataRetentionDays: 7,
    defaultDeny: true,
    deliveryMode: "codex-cli",
    desktopInputScriptPath: path.join(root, "scripts", "Send-CodexDesktopInput.ps1"),
    desktopModelScriptPath: path.join(root, "scripts", "Set-CodexDesktopModel.ps1"),
    desktopResponseTimeoutMs: 900_000,
    executionMode: "restricted",
    logLevel: "minimal",
    logRoot: path.join(root, "state"),
    maxParallelRuns: 1,
    openclawConfigPath: path.join(root, ".openclaw", "openclaw.json"),
    openclawStateRoot: path.join(root, ".openclaw"),
    ownerPeerIds: [],
    pollTimeoutMs: 35_000,
    readonlyPeerIds: [],
    resumeAllSessions: true,
    resumeLast: true,
    sandboxRoot: root,
    skipBacklogOnStart: true,
    storeFullPrompts: false,
    transcriptEnabled: false,
    weixinChannelVersion: "2.1.1",
    ...overrides
  };
}
