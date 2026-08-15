import { existsSync as defaultExistsSync, readdirSync as defaultReaddirSync } from "node:fs";
import path from "node:path";

import { bridgeAccountDirectory, openclawAccountIndexPath } from "./accountStore.js";
import type { BridgeConfig } from "./config.js";
import { validateWorkspace, type WorkspaceValidation } from "./workspaceSecurity.js";

export type ConfigDiagnosticSeverity = "error" | "ok" | "warn";

export interface ConfigDiagnosticCheck {
  detail: string;
  fix?: string;
  label: string;
  ok: boolean;
  severity: ConfigDiagnosticSeverity;
}

export interface ConfigDiagnosticOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  existsSync?: (candidate: string) => boolean;
  listDirectory?: (candidate: string) => string[];
  nodeVersion?: string;
  validateWorkspace?: (config: BridgeConfig) => WorkspaceValidation;
}

export interface ConfigDiagnosticReport {
  checks: ConfigDiagnosticCheck[];
  ok: boolean;
}

export function buildConfigDiagnosticReport(
  config: BridgeConfig,
  options: ConfigDiagnosticOptions = {}
): ConfigDiagnosticReport {
  const checks = buildConfigDiagnostics(config, options);
  return {
    checks,
    ok: !checks.some((check) => !check.ok && check.severity === "error")
  };
}

export function buildConfigDiagnostics(
  config: BridgeConfig,
  options: ConfigDiagnosticOptions = {}
): ConfigDiagnosticCheck[] {
  const env = options.env ?? process.env;
  const existsSync = options.existsSync ?? defaultExistsSync;
  const listDirectory = options.listDirectory ?? ((candidate: string) => defaultReaddirSync(candidate));
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const workspaceValidation = (options.validateWorkspace ?? validateWorkspace)(config);
  const checks: ConfigDiagnosticCheck[] = [];
  const localAccountDirectory = bridgeAccountDirectory(config);
  const openclawAccountIndex = openclawAccountIndexPath(config);

  const nodeMajor = Number.parseInt(nodeVersion.split(".")[0] ?? "", 10);
  checks.push({
    detail: `Node.js ${nodeVersion}; required >=22.`,
    fix: "Install Node.js 22 or newer.",
    label: "Node.js version",
    ok: Number.isFinite(nodeMajor) && nodeMajor >= 22,
    severity: Number.isFinite(nodeMajor) && nodeMajor >= 22 ? "ok" : "error"
  });

  checks.push(pathCheck({
    detail: `Workspace path: ${config.codexCwd}`,
    existsSync,
    fix: "Set CODEX_WEIXIN_CWD to the project folder that Codex should operate in.",
    label: "Codex workspace",
    path: config.codexCwd,
    severity: "error"
  }));

  checks.push({
    detail: workspaceValidation.ok
      ? `Workspace security checks passed for ${workspaceValidation.resolvedPath}.`
      : workspaceValidation.reason,
    fix: "Use a dedicated workspace inside CODEX_WEIXIN_SANDBOX_ROOT and CODEX_WEIXIN_ALLOWED_WORKSPACE_ROOTS.",
    label: "Workspace security",
    ok: config.executionMode === "restricted" && workspaceValidation.ok,
    severity: config.executionMode === "restricted" && workspaceValidation.ok ? "ok" : "error"
  });

  const sandboxConfigured = Boolean(config.sandboxRoot) || config.allowedWorkspaceRoots.length > 0;
  checks.push({
    detail: sandboxConfigured
      ? `Sandbox root configured=${Boolean(config.sandboxRoot)}; allowed workspace roots=${config.allowedWorkspaceRoots.length}.`
      : "No sandbox root or allowed workspace root is configured.",
    fix: "Set CODEX_WEIXIN_SANDBOX_ROOT or CODEX_WEIXIN_ALLOWED_WORKSPACE_ROOTS to a dedicated project boundary.",
    label: "Sandbox policy",
    ok: sandboxConfigured,
    severity: sandboxConfigured ? "ok" : config.executionMode === "restricted" ? "error" : "warn"
  });

  checks.push({
    detail: path.isAbsolute(config.logRoot)
      ? `State root: ${config.logRoot}`
      : `State root is not absolute: ${config.logRoot}`,
    fix: "Use an absolute CODEX_WEIXIN_STATE_ROOT so launchers and services write state to the same place.",
    label: "Bridge state root",
    ok: path.isAbsolute(config.logRoot),
    severity: path.isAbsolute(config.logRoot) ? "ok" : "warn"
  });

  if (
    env.CODEX_WEIXIN_LOG_ROOT &&
    env.CODEX_WEIXIN_STATE_ROOT &&
    env.CODEX_WEIXIN_LOG_ROOT !== env.CODEX_WEIXIN_STATE_ROOT
  ) {
    checks.push({
      detail: "Both CODEX_WEIXIN_LOG_ROOT and CODEX_WEIXIN_STATE_ROOT are set; LOG_ROOT wins.",
      fix: "Prefer CODEX_WEIXIN_STATE_ROOT for new installs and leave CODEX_WEIXIN_LOG_ROOT empty unless you need legacy compatibility.",
      label: "State root precedence",
      ok: false,
      severity: "warn"
    });
  }

  let localAccountExists = false;
  if (existsSync(localAccountDirectory)) {
    try {
      localAccountExists = listDirectory(localAccountDirectory).some((entry) => entry.endsWith(".json"));
    } catch {
      localAccountExists = false;
    }
  }
  const openclawAccountExists = existsSync(openclawAccountIndex);
  checks.push({
    detail: localAccountExists
      ? `Bridge account directory: ${localAccountDirectory}`
      : openclawAccountExists
        ? `OpenClaw-compatible account index: ${openclawAccountIndex}`
        : "No bridge or OpenClaw-compatible Weixin account state was found.",
    fix: "Run `weixin-codex-bridge login`, or point OPENCLAW_STATE_DIR at an existing Weixin state root.",
    label: "Weixin account state",
    ok: localAccountExists || openclawAccountExists,
    severity: localAccountExists || openclawAccountExists ? "ok" : "error"
  });

  const ownerConfigured = config.ownerPeerIds.length > 0;
  checks.push({
    detail: `${config.ownerPeerIds.length} owner, ${config.allowedPeerIds.length} allowed, ${config.readonlyPeerIds.length} readonly peer(s) configured.`,
    fix: "Set CODEX_WEIXIN_OWNER_PEER_IDS to at least one trusted owner peer ID.",
    label: "Role allowlists",
    ok: ownerConfigured,
    severity: ownerConfigured ? "ok" : config.allowUnconfiguredDevMode ? "warn" : "error"
  });

  checks.push({
    detail: config.defaultDeny ? "Unknown peers are denied." : "Unknown peers are not denied by default.",
    fix: "Set CODEX_WEIXIN_DEFAULT_DENY=true.",
    label: "Default-deny",
    ok: config.defaultDeny,
    severity: config.defaultDeny ? "ok" : "error"
  });

  checks.push({
    detail: `Execution mode: ${config.executionMode}; full-auto=${config.allowFullAuto}; skip-git-check=${config.allowSkipGitCheck}.`,
    fix: "Use restricted mode with full-auto and skip-git-check disabled.",
    label: "Execution safety",
    ok: config.executionMode === "restricted" && !config.allowFullAuto && !config.allowSkipGitCheck,
    severity: config.executionMode === "restricted" && !config.allowFullAuto && !config.allowSkipGitCheck ? "ok" : "error"
  });

  const privacyDefaults = config.logLevel === "minimal" &&
    !config.transcriptEnabled &&
    !config.storeFullPrompts;
  checks.push({
    detail: `log=${config.logLevel}; transcripts=${config.transcriptEnabled}; full-prompts=${config.storeFullPrompts}; retention=${config.dataRetentionDays} day(s).`,
    fix: "Use minimal logging with transcripts and full-prompt storage disabled unless explicitly required.",
    label: "Privacy defaults",
    ok: privacyDefaults,
    severity: privacyDefaults ? "ok" : "warn"
  });

  if (config.deliveryMode === "desktop-ui") {
    checks.push(pathCheck({
      detail: `Codex state: ${config.codexHome}`,
      existsSync,
      fix: "Install and start Codex Desktop, or set CODEX_HOME to its state directory.",
      label: "Codex Desktop state",
      path: config.codexHome,
      severity: "error"
    }));

    checks.push(pathCheck({
      detail: `Input script: ${config.desktopInputScriptPath}`,
      existsSync,
      fix: "Set CODEX_WEIXIN_DESKTOP_INPUT_SCRIPT to scripts/Send-CodexDesktopInput.ps1 from this repo.",
      label: "Desktop input script",
      path: config.desktopInputScriptPath,
      severity: "error"
    }));

    checks.push(pathCheck({
      detail: `Model script: ${config.desktopModelScriptPath}`,
      existsSync,
      fix: "Set CODEX_WEIXIN_DESKTOP_MODEL_SCRIPT to scripts/Set-CodexDesktopModel.ps1 from this repo.",
      label: "Desktop model script",
      path: config.desktopModelScriptPath,
      severity: "error"
    }));

    const requestedParallel = Number(env.CODEX_WEIXIN_MAX_PARALLEL);
    if (Number.isFinite(requestedParallel) && requestedParallel > 1) {
      checks.push({
        detail: `CODEX_WEIXIN_MAX_PARALLEL=${env.CODEX_WEIXIN_MAX_PARALLEL} is ignored in desktop-ui mode.`,
        fix: "Use codex-cli for true multi-worker concurrency, or keep desktop-ui single-lane for UI-only safety.",
        label: "Desktop UI parallel setting",
        ok: false,
        severity: "warn"
      });
    }
  }

  if (config.deliveryMode === "codex-cli" || config.cliFallbackEnabled) {
    const commandFound = commandExists(config.codexCmdPath, env, existsSync);
    checks.push({
      detail: commandFound
        ? `Codex command: ${config.codexCmdPath}`
        : `Codex command was not found: ${config.codexCmdPath}`,
      fix: "Install Codex CLI or set CODEX_CMD_PATH to its executable path.",
      label: "Codex command",
      ok: commandFound,
      severity: commandFound ? "ok" : "error"
    });
  }

  return checks;
}

function commandExists(
  command: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  existsSync: (candidate: string) => boolean
): boolean {
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return existsSync(command);
  }

  const pathValue = env.PATH ?? env.Path ?? "";
  return pathValue
    .split(path.delimiter)
    .filter(Boolean)
    .some((directory) => existsSync(path.join(directory, command)));
}

function pathCheck(params: {
  detail: string;
  existsSync: (candidate: string) => boolean;
  fix: string;
  label: string;
  path: string;
  severity: Exclude<ConfigDiagnosticSeverity, "ok">;
}): ConfigDiagnosticCheck {
  const ok = params.existsSync(params.path);
  return {
    detail: ok ? params.detail : `${params.detail} was not found.`,
    fix: params.fix,
    label: params.label,
    ok,
    severity: ok ? "ok" : params.severity
  };
}
