import { existsSync as defaultExistsSync } from "node:fs";
import path from "node:path";

import type { BridgeConfig } from "./config.js";

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
}

export function buildConfigDiagnostics(
  config: BridgeConfig,
  options: ConfigDiagnosticOptions = {}
): ConfigDiagnosticCheck[] {
  const env = options.env ?? process.env;
  const existsSync = options.existsSync ?? defaultExistsSync;
  const checks: ConfigDiagnosticCheck[] = [];
  const accountIndexPath = path.join(config.openclawStateRoot, "openclaw-weixin", "accounts.json");

  checks.push(pathCheck({
    detail: `Workspace path: ${config.codexCwd}`,
    existsSync,
    fix: "Set CODEX_WEIXIN_CWD to the project folder that Codex should operate in.",
    label: "Codex workspace",
    path: config.codexCwd,
    severity: "error"
  }));

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

  checks.push(pathCheck({
    detail: `Account index: ${accountIndexPath}`,
    existsSync,
    fix: "Run the existing Weixin/OpenClaw QR login first, then point OPENCLAW_STATE_DIR at that state root.",
    label: "Weixin account index",
    path: accountIndexPath,
    severity: "error"
  }));

  if (config.deliveryMode === "desktop-ui") {
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
    checks.push(pathCheck({
      detail: `Codex command: ${config.codexCmdPath}`,
      existsSync,
      fix: "Install Codex CLI or set CODEX_CMD_PATH to the working codex.cmd path.",
      label: "Codex command",
      path: config.codexCmdPath,
      severity: "error"
    }));
  }

  return checks;
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
