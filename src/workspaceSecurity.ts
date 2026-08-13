/**
 * Workspace path security for Weixin Codex Bridge.
 *
 * Restricted mode fails closed unless Codex runs inside at least one explicit,
 * real filesystem boundary.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { BridgeConfig } from "./config.js";

const FORBIDDEN_DIRS: string[] = [
  os.homedir(),
  path.join(os.homedir(), ".codex"),
  path.join(os.homedir(), ".ssh"),
  path.join(os.homedir(), ".openclaw"),
  path.join(os.homedir(), "AppData"),
  path.join(os.homedir(), "Library"),
  process.env.LOCALAPPDATA ?? "",
  process.env.APPDATA ?? "",
  process.env.TEMP ?? "",
  process.env.TMP ?? ""
].filter(Boolean);

export interface WorkspaceValidation {
  allowedWorkspaceRoots: string[];
  ok: boolean;
  resolvedPath: string;
  reason: string;
}

function comparable(candidate: string): string {
  return process.platform === "win32" ? candidate.toLowerCase() : candidate;
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(comparable(root), comparable(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveExistingPath(candidate: string, label: string): string {
  const resolved = path.resolve(candidate);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    throw new Error(`${label} does not resolve to an existing path: ${resolved}`);
  }
}

function failed(
  config: BridgeConfig,
  resolvedPath: string,
  reason: string
): WorkspaceValidation {
  return {
    allowedWorkspaceRoots: config.allowedWorkspaceRoots,
    ok: false,
    reason,
    resolvedPath
  };
}

export function validateWorkspace(config: BridgeConfig): WorkspaceValidation {
  const lexicalPath = path.resolve(config.codexCwd);
  for (const forbidden of FORBIDDEN_DIRS) {
    const lexicalForbidden = path.resolve(forbidden);
    if (isInside(lexicalPath, lexicalForbidden)) {
      return failed(
        config,
        lexicalPath,
        `Workspace resolves inside a forbidden directory: ${forbidden}`
      );
    }
  }

  let realPath: string;
  try {
    realPath = resolveExistingPath(config.codexCwd, "Workspace");
  } catch (error) {
    return failed(config, lexicalPath, error instanceof Error ? error.message : String(error));
  }

  for (const forbidden of FORBIDDEN_DIRS) {
    try {
      const realForbidden = resolveExistingPath(forbidden, "Forbidden directory");
      if (isInside(realPath, realForbidden)) {
        return failed(config, realPath, `Workspace real path is inside a forbidden directory: ${realForbidden}`);
      }
    } catch {
      // A missing forbidden directory cannot contain the existing workspace.
    }
  }

  if (!config.sandboxRoot && config.allowedWorkspaceRoots.length === 0) {
    return failed(
      config,
      realPath,
      "Restricted mode requires CODEX_WEIXIN_SANDBOX_ROOT or CODEX_WEIXIN_ALLOWED_WORKSPACE_ROOTS."
    );
  }

  if (config.sandboxRoot) {
    let sandboxReal: string;
    try {
      sandboxReal = resolveExistingPath(config.sandboxRoot, "Sandbox root");
    } catch (error) {
      return failed(config, realPath, error instanceof Error ? error.message : String(error));
    }
    if (!isInside(realPath, sandboxReal)) {
      return failed(config, realPath, `Workspace is outside the sandbox root: ${sandboxReal}`);
    }
  }

  if (config.allowedWorkspaceRoots.length > 0) {
    let allowedRoots: string[];
    try {
      allowedRoots = config.allowedWorkspaceRoots.map((root) =>
        resolveExistingPath(root, "Allowed workspace root")
      );
    } catch (error) {
      return failed(config, realPath, error instanceof Error ? error.message : String(error));
    }
    if (!allowedRoots.some((root) => isInside(realPath, root))) {
      return failed(
        config,
        realPath,
        `Workspace is not inside any allowed workspace root: ${allowedRoots.join(", ")}`
      );
    }
  }

  return {
    allowedWorkspaceRoots: config.allowedWorkspaceRoots,
    ok: true,
    reason: "ok",
    resolvedPath: realPath
  };
}

export function requireSecureWorkspace(config: BridgeConfig): void {
  if (config.executionMode === "high-risk") {
    console.warn(
      "⚠️  CODEX_WEIXIN_EXECUTION_MODE=high-risk — workspace security checks are bypassed."
    );
    return;
  }

  const validation = validateWorkspace(config);
  if (!validation.ok) {
    throw new Error([
      `Workspace security check failed: ${validation.reason}`,
      "",
      `Resolved path: ${validation.resolvedPath}`,
      "Set CODEX_WEIXIN_SANDBOX_ROOT to an isolated directory, or",
      "set CODEX_WEIXIN_EXECUTION_MODE=high-risk to bypass (not recommended)."
    ].join("\n"));
  }
}
