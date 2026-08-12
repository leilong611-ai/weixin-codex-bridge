#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

if (process.platform === "win32") {
  throw new Error("CLI-only validation is intended for macOS and Linux.");
}

const baseRoot = process.env.CODEX_WEIXIN_CLI_ONLY_TEST_ROOT ?? "/var/tmp";
const root = fs.mkdtempSync(path.join(baseRoot, "weixin-codex-cli-only-"));

try {
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  const accountRoot = path.join(stateRoot, "openclaw-weixin");
  const codexHome = path.join(root, "codex-home");
  const fakeCodex = path.join(root, "codex");
  for (const directory of [workspace, accountRoot, codexHome]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(path.join(accountRoot, "accounts.json"), "[]\n", "utf8");
  fs.writeFileSync(fakeCodex, "#!/bin/sh\nexit 0\n", { mode: 0o700 });

  const result = spawnSync(process.execPath, ["dist/cli.js", "doctor"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      CODEX_CMD_PATH: fakeCodex,
      CODEX_HOME: codexHome,
      CODEX_WEIXIN_ALLOW_FULL_AUTO: "false",
      CODEX_WEIXIN_ALLOW_SKIP_GIT_CHECK: "false",
      CODEX_WEIXIN_ALLOWED_WORKSPACE_ROOTS: workspace,
      CODEX_WEIXIN_AUTO_DESKTOP_SESSION: "false",
      CODEX_WEIXIN_CLI_FALLBACK: "false",
      CODEX_WEIXIN_CWD: workspace,
      CODEX_WEIXIN_DEFAULT_DENY: "true",
      CODEX_WEIXIN_DELIVERY_MODE: "codex-cli",
      CODEX_WEIXIN_EXECUTION_MODE: "restricted",
      CODEX_WEIXIN_LOG_LEVEL: "minimal",
      CODEX_WEIXIN_OWNER_PEER_IDS: "placeholder-owner",
      CODEX_WEIXIN_SANDBOX_ROOT: root,
      CODEX_WEIXIN_STATE_ROOT: stateRoot,
      CODEX_WEIXIN_STORE_FULL_PROMPTS: "false",
      CODEX_WEIXIN_TRANSCRIPT_ENABLED: "false",
      OPENCLAW_STATE_DIR: stateRoot
    }
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `doctor exited ${result.status}`);
  }

  const report = JSON.parse(result.stdout);
  const labels = new Set(report.checks?.map((check) => check.label));
  for (const label of ["Codex command", "Workspace security", "Sandbox policy", "Role allowlists"]) {
    if (!labels.has(label)) {
      throw new Error(`doctor report is missing ${label}`);
    }
  }
  if (!report.ok || result.stdout.includes("placeholder-owner")) {
    throw new Error("doctor report failed or exposed the placeholder owner value");
  }

  console.log("CLI-only validation passed with dummy state and no external connections.");
} finally {
  fs.rmSync(root, { force: true, recursive: true });
}
