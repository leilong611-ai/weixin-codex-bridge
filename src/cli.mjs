#!/usr/bin/env node

import fs from "node:fs";

import { runBridge } from "./bridge.mjs";
import { resolveConfig } from "./config.mjs";
import { doctorCodex } from "./codex-runner.mjs";
import { loginWeixin } from "./login.mjs";
import { info } from "./log.mjs";
import { clearAccount, clearSyncCursor, loadAccount, loadRuntime } from "./state.mjs";

function printHelp() {
  console.log(`
Usage:
  node src/cli.mjs login --workspace "/abs/path"
  node src/cli.mjs serve
  node src/cli.mjs start --workspace "/abs/path"
  node src/cli.mjs logout
  node src/cli.mjs doctor

Options:
  --workspace <path>         Codex workspace root
  --base-url <url>           Weixin API base url
  --bot-type <id>            Weixin bot type (default 3)
  --session-prefix <prefix>  Per-user Codex session prefix
  --timeout <sec>            Codex timeout seconds
  --poll-timeout <ms>        Weixin long-poll timeout
  --acpx-command <path>      Explicit acpx binary
`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value == null || value.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = value;
    i += 1;
  }
  return args;
}

function buildOverrides(args) {
  return {
    workspace: args.workspace,
    baseUrl: args["base-url"],
    botType: args["bot-type"],
    sessionPrefix: args["session-prefix"],
    codexTimeoutSeconds: args.timeout ? Number(args.timeout) : undefined,
    longPollTimeoutMs: args["poll-timeout"] ? Number(args["poll-timeout"]) : undefined,
    acpxCommand: args["acpx-command"],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "help";

  if (command === "help" || args.help) {
    printHelp();
    return;
  }

  if (command === "logout") {
    clearAccount();
    clearSyncCursor();
    console.log("已清除 standalone bridge 的微信凭证和同步游标。");
    return;
  }

  const config = resolveConfig(buildOverrides(args));

  if (command === "doctor") {
    const account = loadAccount();
    const runtime = loadRuntime();
    const acpxExists = fs.existsSync(config.acpxCommand);
    const acpxVersion = acpxExists ? await doctorCodex(config) : "(missing)";
    console.log(JSON.stringify({
      workspace: config.workspace,
      acpxCommand: config.acpxCommand,
      acpxExists,
      acpxVersion,
      linkedAccount: account,
      runtime,
    }, null, 2));
    return;
  }

  if (command === "login") {
    await loginWeixin(config);
    return;
  }

  if (command === "serve") {
    await runBridge(config);
    return;
  }

  if (command === "start") {
    if (!loadAccount()) {
      await loginWeixin(config);
    } else {
      info("Using existing linked Weixin account.");
    }
    await runBridge(config);
    return;
  }

  printHelp();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
