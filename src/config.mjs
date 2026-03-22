import fs from "node:fs";
import path from "node:path";

import { PROJECT_ROOT } from "./paths.mjs";
import { loadRuntime, saveRuntime } from "./state.mjs";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const DEFAULT_BOT_TYPE = "3";
export const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
export const DEFAULT_POLL_RETRY_MS = 2_000;
export const DEFAULT_TIMEOUT_SECONDS = 300;
export const DEFAULT_SESSION_PREFIX = "wx";

function localAcpxPath() {
  const binName = process.platform === "win32" ? "acpx.cmd" : "acpx";
  return path.join(PROJECT_ROOT, "node_modules", ".bin", binName);
}

export function resolveConfig(overrides = {}) {
  const runtime = loadRuntime();
  const workspace =
    overrides.workspace ??
    runtime.workspace ??
    process.cwd();
  const config = {
    baseUrl: overrides.baseUrl ?? runtime.baseUrl ?? DEFAULT_BASE_URL,
    botType: overrides.botType ?? runtime.botType ?? DEFAULT_BOT_TYPE,
    workspace,
    longPollTimeoutMs:
      overrides.longPollTimeoutMs ??
      runtime.longPollTimeoutMs ??
      DEFAULT_LONG_POLL_TIMEOUT_MS,
    retryDelayMs:
      overrides.retryDelayMs ??
      runtime.retryDelayMs ??
      DEFAULT_POLL_RETRY_MS,
    codexTimeoutSeconds:
      overrides.codexTimeoutSeconds ??
      runtime.codexTimeoutSeconds ??
      DEFAULT_TIMEOUT_SECONDS,
    sessionPrefix:
      overrides.sessionPrefix ??
      runtime.sessionPrefix ??
      DEFAULT_SESSION_PREFIX,
    acpxCommand:
      overrides.acpxCommand ??
      runtime.acpxCommand ??
      localAcpxPath(),
  };

  if (!path.isAbsolute(config.workspace)) {
    throw new Error(`workspace must be an absolute path: ${config.workspace}`);
  }
  if (!fs.existsSync(config.workspace)) {
    throw new Error(`workspace does not exist: ${config.workspace}`);
  }
  return config;
}

export function persistRuntimeConfig(config) {
  saveRuntime({
    baseUrl: config.baseUrl,
    botType: config.botType,
    workspace: config.workspace,
    longPollTimeoutMs: config.longPollTimeoutMs,
    retryDelayMs: config.retryDelayMs,
    codexTimeoutSeconds: config.codexTimeoutSeconds,
    sessionPrefix: config.sessionPrefix,
    acpxCommand: config.acpxCommand,
  });
}
