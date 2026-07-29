/**
 * Workspace path security for Weixin Codex Bridge.
 *
 * Ensures Codex only runs in approved sandbox workspaces and rejects
 * symlink escape, homedir leaks, and credential-directory access.
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";

import type { BridgeConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Paths that are NEVER acceptable as a Codex workspace
// ---------------------------------------------------------------------------

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
  process.env.TMP ?? "",
].filter(Boolean);

// ---------------------------------------------------------------------------
// Workspace validation
// ---------------------------------------------------------------------------

export interface WorkspaceValidation {
  allowedWorkspaceRoots: string[];
  ok: boolean;
  resolvedPath: string;
  reason: string;
}

/**
 * Validate a workspace path against security rules.
 *
 * 1. Reject forbidden directories (home, .codex, .ssh, credentials, temp).
 * 2. Reject symlink-based escape.
 * 3. Reject paths outside the sandboxRoot (if set).
 * 4. Reject paths outside allowedWorkspaceRoots (if set).
 */
export function validateWorkspace(config: BridgeConfig): WorkspaceValidation {
  const resolvedPath = path.resolve(config.codexCwd);
  const normPath = resolvedPath.toLowerCase();

  // Check forbidden directories
  for (const forbidden of FORBIDDEN_DIRS) {
    if (!forbidden) continue;
    const normForbidden = path.resolve(forbidden).toLowerCase();
    if (normPath === normForbidden || normPath.startsWith(normForbidden + path.sep)) {
      return {
        allowedWorkspaceRoots: config.allowedWorkspaceRoots,
        ok: false,
        resolvedPath,
        reason: `Workspace resolves inside a forbidden directory: ${forbidden}`,
      };
    }
  }

  // Symlink escape check: the resolved realpath must match the resolved path
  // (if the path has symlinks, the real location shouldn't be outside the intended tree)
  try {
    const realPath = fs.realpathSync(resolvedPath);
    // If the project root itself is a symlink, resolve it
    const cwdReal = fs.realpathSync(process.cwd());
    const normReal = realPath.toLowerCase();
    const forbiddenReal = FORBIDDEN_DIRS.map((d) => {
      try {
        return fs.realpathSync(d).toLowerCase();
      } catch {
        return "";
      }
    }).filter(Boolean);
    for (const fr of forbiddenReal) {
      if (normReal === fr || normReal.startsWith(fr + path.sep)) {
        return {
          allowedWorkspaceRoots: config.allowedWorkspaceRoots,
          ok: false,
          resolvedPath: realPath,
          reason: `Workspace symlink resolves into a forbidden directory: ${realPath}`,
        };
      }
    }
  } catch {
    // realpathSync fails on non-existent paths — the path check will catch it
  }

  // Sandbox root check
  if (config.sandboxRoot) {
    const sandboxNorm = path.resolve(config.sandboxRoot).toLowerCase();
    if (!normPath.startsWith(sandboxNorm + path.sep) && normPath !== sandboxNorm) {
      return {
        allowedWorkspaceRoots: config.allowedWorkspaceRoots,
        ok: false,
        resolvedPath,
        reason: `Workspace is outside the sandbox root: ${config.sandboxRoot}`,
      };
    }
  }

  // Allowed workspace roots check
  if (config.allowedWorkspaceRoots.length > 0) {
    const withinAllowed = config.allowedWorkspaceRoots.some((root) => {
      const normRoot = path.resolve(root).toLowerCase();
      return normPath === normRoot || normPath.startsWith(normRoot + path.sep);
    });
    if (!withinAllowed) {
      return {
        allowedWorkspaceRoots: config.allowedWorkspaceRoots,
        ok: false,
        resolvedPath,
        reason: `Workspace is not inside any allowed workspace root: ${config.allowedWorkspaceRoots.join(", ")}`,
      };
    }
  }

  return {
    allowedWorkspaceRoots: config.allowedWorkspaceRoots,
    ok: true,
    resolvedPath,
    reason: "ok",
  };
}

export function requireSecureWorkspace(config: BridgeConfig): void {
  if (config.executionMode === "high-risk") {
    // Only log a warning in high-risk mode
    console.warn(
      "⚠️  CODEX_WEIXIN_EXECUTION_MODE=high-risk — workspace security checks are bypassed.",
    );
    return;
  }

  const validation = validateWorkspace(config);
  if (!validation.ok) {
    throw new Error(
      [
        `Workspace security check failed: ${validation.reason}`,
        "",
        `Resolved path: ${validation.resolvedPath}`,
        "Set CODEX_WEIXIN_SANDBOX_ROOT to an isolated directory, or",
        "set CODEX_WEIXIN_EXECUTION_MODE=high-risk to bypass (not recommended).",
      ].join("\n"),
    );
  }
}
