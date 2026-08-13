#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "weixin-codex-pack-"));
const packRoot = path.join(temporaryRoot, "pack");
const extractRoot = path.join(temporaryRoot, "extract");
mkdirSync(packRoot);
mkdirSync(extractRoot);

try {
  const pack = run("npm", [
    "pack",
    "--cache",
    path.join(temporaryRoot, "npm-cache"),
    "--ignore-scripts",
    "--pack-destination",
    packRoot,
    "--json"
  ], { shell: process.platform === "win32" });
  const packed = JSON.parse(pack.stdout);
  const fileName = packed[0]?.filename;
  if (typeof fileName !== "string") {
    fail("npm pack did not report a tarball filename.");
  }

  const tarballPath = path.join(packRoot, fileName);
  run("tar", ["-xzf", tarballPath, "-C", extractRoot]);
  const packageRoot = path.join(extractRoot, "package");

  const requiredFiles = [
    ".env.example",
    "CHANGELOG.md",
    "LICENSE",
    "README.en.md",
    "README.md",
    "SECURITY.md",
    "dist/cli.js",
    "docs/threat-model-walkthrough.md",
    "package.json",
    "scripts/Install-CodexWeixinCompanionShortcut.ps1",
    "scripts/Launch-CodexWithWeixinBridge-Hidden.vbs",
    "scripts/Send-CodexDesktopInput.ps1",
    "scripts/Set-CodexDesktopModel.ps1",
    "scripts/Start-CodexWeixinBridge.ps1",
    "scripts/Start-CodexWithWeixinBridge.ps1",
    "scripts/Status-CodexWeixinBridge.ps1",
    "scripts/Test-CodexWeixinSetup.ps1",
    "scripts/Watch-CodexWeixinBridge.ps1"
  ];
  for (const fileName of requiredFiles) {
    if (!existsSync(path.join(packageRoot, fileName))) {
      fail(`required package file is missing: ${fileName}`);
    }
  }

  const packagedFiles = walk(packageRoot);
  for (const fileName of packagedFiles) {
    const normalized = fileName.replaceAll(path.sep, "/");
    if (
      normalized === ".env" ||
      normalized.startsWith(".local/") ||
      normalized.startsWith("state/") ||
      normalized.startsWith("logs/") ||
      normalized.startsWith("test/") ||
      normalized.startsWith("node_modules/") ||
      /\.(?:db|db-shm|db-wal|sqlite|sqlite3|log|pid)$/i.test(normalized) ||
      /^src\/.*\.mjs$/i.test(normalized)
    ) {
      fail(`forbidden package content found: ${normalized}`);
    }
  }

  const packagedJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (packagedJson.private !== true) {
    fail("the package must remain private.");
  }
  if (packagedJson.bin?.["weixin-codex-bridge"] !== "dist/cli.js") {
    fail("the package CLI bin entry is missing or incorrect.");
  }
  if (!readFileSync(path.join(packageRoot, "dist", "cli.js"), "utf8").startsWith("#!/usr/bin/env node")) {
    fail("dist/cli.js is missing its executable shebang.");
  }

  const installRoot = path.join(temporaryRoot, "install");
  const unrelatedRoot = path.join(temporaryRoot, "unrelated-cwd");
  const stateRoot = path.join(temporaryRoot, "state");
  const accountDirectory = path.join(stateRoot, "weixin-accounts", "accounts");
  const codexHome = path.join(temporaryRoot, "codex-home");
  mkdirSync(installRoot);
  mkdirSync(unrelatedRoot);
  mkdirSync(accountDirectory, { recursive: true });
  mkdirSync(codexHome);
  writeFileSync(path.join(accountDirectory, "placeholder-im-bot.json"), JSON.stringify({
    baseUrl: "https://ilinkai.weixin.qq.com",
    token: "placeholder-token"
  }));
  run("npm", [
    "install",
    "--cache",
    path.join(temporaryRoot, "npm-install-cache"),
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    "--prefix",
    installRoot,
    tarballPath
  ], { shell: process.platform === "win32" });

  const binPath = process.platform === "win32"
    ? path.join(installRoot, "node_modules", ".bin", "weixin-codex-bridge.cmd")
    : path.join(installRoot, "node_modules", ".bin", "weixin-codex-bridge");
  const help = run(binPath, ["help"], {
    cwd: unrelatedRoot,
    shell: process.platform === "win32"
  }).stdout;
  const version = run(binPath, ["version"], {
    cwd: unrelatedRoot,
    shell: process.platform === "win32"
  }).stdout.trim();
  if (!help.includes("weixin-codex-bridge [command]") || version !== packagedJson.version) {
    fail("installed package CLI help/version validation failed.");
  }
  const doctor = run(binPath, ["doctor"], {
    cwd: unrelatedRoot,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_WEIXIN_ALLOWED_WORKSPACE_ROOTS: unrelatedRoot,
      CODEX_WEIXIN_AUTO_DESKTOP_SESSION: "false",
      CODEX_WEIXIN_CWD: unrelatedRoot,
      CODEX_WEIXIN_DEFAULT_DENY: "true",
      CODEX_WEIXIN_EXECUTION_MODE: "restricted",
      CODEX_WEIXIN_LOG_ROOT: stateRoot,
      CODEX_WEIXIN_OWNER_PEER_IDS: "placeholder-owner",
      CODEX_WEIXIN_SANDBOX_ROOT: unrelatedRoot,
      CODEX_WEIXIN_STATE_ROOT: stateRoot
    },
    shell: process.platform === "win32"
  });
  const doctorReport = JSON.parse(doctor.stdout);
  const inputCheck = doctorReport.checks?.find((check) => check.label === "Desktop input script");
  const modelCheck = doctorReport.checks?.find((check) => check.label === "Desktop model script");
  if (
    !doctorReport.ok ||
    !inputCheck?.ok ||
    !modelCheck?.ok ||
    inputCheck.detail.includes(unrelatedRoot) ||
    modelCheck.detail.includes(unrelatedRoot)
  ) {
    fail("installed package doctor did not resolve bundled Desktop scripts safely.");
  }

  console.log(`Package verified: ${fileName} (${packagedFiles.length} files).`);
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    env: options.env ?? process.env,
    shell: options.shell ?? false
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "unknown error").trim();
    fail(`${command} failed: ${detail}`);
  }
  return result;
}

function walk(directory, relative = "") {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const childRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(path.join(directory, entry.name), childRelative));
    } else {
      files.push(childRelative);
    }
  }
  return files;
}

function fail(message) {
  throw new Error(message);
}
