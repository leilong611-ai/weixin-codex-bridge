#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  listWeixinAccounts,
  removeLocalWeixinAccount,
  type WeixinAccountSummary
} from "./accountStore.js";
import { requireAuthorizedStartup } from "./auth.js";
import { CodexWeixinBridge } from "./bridge.js";
import { loadBridgeConfig, type BridgeConfig } from "./config.js";
import { buildConfigDiagnosticReport, type ConfigDiagnosticReport } from "./configDiagnostics.js";
import { startConsoleServer } from "./consoleServer.js";
import { loginWeixin } from "./weixinLogin.js";
import { requireSecureWorkspace } from "./workspaceSecurity.js";

const HELP = `Usage: weixin-codex-bridge [command]

Commands:
  start                 Start the bridge (default)
  doctor                Run a read-only configuration preflight
  login                 Sign in with a WeChat QR code
  accounts              List local and OpenClaw-compatible accounts
  logout [account-id]   Remove an account created by this bridge
  version               Print the installed version
  help                  Show this help`;

interface CliDependencies {
  doctor: (config: BridgeConfig) => ConfigDiagnosticReport;
  listAccounts: (config: BridgeConfig) => Promise<WeixinAccountSummary[]>;
  loadConfig: () => BridgeConfig;
  login: (config: BridgeConfig, report: (message: string) => void) => Promise<void>;
  output: (message: string) => void;
  removeAccount: (config: BridgeConfig, accountId: string) => Promise<boolean>;
  start: (config: BridgeConfig) => Promise<void>;
  version: () => string;
}

function readPackageVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  ) as { version?: unknown };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("package.json does not contain a valid version.");
  }
  return packageJson.version;
}

async function startBridge(config: BridgeConfig): Promise<void> {
  requireAuthorizedStartup(config);
  requireSecureWorkspace(config);

  const bridge = new CodexWeixinBridge(config);
  await bridge.init();

  console.log("[codex-weixin] bridge started");
  console.log(`[codex-weixin] state root: ${config.logRoot}`);

  const controller = new AbortController();
  const consoleServer = config.consoleEnabled
    ? await startConsoleServer(config, { getTaskSnapshot: () => bridge.getTaskSnapshot() })
    : undefined;
  if (consoleServer) {
    console.log(`[codex-weixin] console: ${consoleServer.url}`);
  }
  process.on("SIGINT", () => controller.abort());
  process.on("SIGTERM", () => controller.abort());
  try {
    await bridge.runForever(controller.signal);
  } finally {
    await consoleServer?.close();
  }
}

const defaultDependencies: CliDependencies = {
  doctor: buildConfigDiagnosticReport,
  listAccounts: listWeixinAccounts,
  loadConfig: loadBridgeConfig,
  login: async (config, report) => {
    await loginWeixin(config, { report });
  },
  output: console.log,
  removeAccount: removeLocalWeixinAccount,
  start: startBridge,
  version: readPackageVersion
};

export async function runCli(
  args: string[],
  overrides: Partial<CliDependencies> = {}
): Promise<number> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const command = args[0] ?? "start";

  if (command === "help" || command === "--help" || command === "-h") {
    dependencies.output(HELP);
    return 0;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    dependencies.output(dependencies.version());
    return 0;
  }

  const config = dependencies.loadConfig();
  if (command === "doctor") {
    const report = dependencies.doctor(config);
    dependencies.output(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }
  if (command === "login") {
    await dependencies.login(config, dependencies.output);
    return 0;
  }
  if (command === "accounts") {
    const accounts = await dependencies.listAccounts(config);
    if (accounts.length === 0) {
      dependencies.output("No Weixin accounts found. Run `weixin-codex-bridge login`.");
      return 0;
    }
    for (const account of accounts) {
      dependencies.output(`${account.accountId}\t${account.source}`);
    }
    return 0;
  }
  if (command === "logout") {
    const accounts = await dependencies.listAccounts(config);
    const localAccounts = accounts.filter(({ source }) => source === "bridge");
    const accountId = args[1] ?? config.accountId ??
      (localAccounts.length === 1 ? localAccounts[0]?.accountId : undefined);
    if (!accountId) {
      throw new Error(
        localAccounts.length === 0
          ? "No bridge-managed account is available to remove."
          : "More than one bridge-managed account exists; provide an account ID."
      );
    }
    if (!localAccounts.some((account) => account.accountId === accountId)) {
      throw new Error(
        "The requested account is not managed by this bridge. OpenClaw-compatible accounts are never deleted."
      );
    }
    if (!await dependencies.removeAccount(config, accountId)) {
      throw new Error("The requested bridge-managed account no longer exists.");
    }
    dependencies.output(`Removed bridge-managed account ${accountId}.`);
    return 0;
  }
  if (command === "start") {
    await dependencies.start(config);
    return 0;
  }

  throw new Error(`Unknown command: ${command}. Run with help for supported commands.`);
}

async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv.slice(2));
}

const entryPoint = process.argv[1]
  ? pathToFileURL(realpathSync(process.argv[1])).href
  : undefined;
if (entryPoint === import.meta.url) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
