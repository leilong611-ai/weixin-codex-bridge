import { loadBridgeConfig } from "./config.js";
import { CodexWeixinBridge } from "./bridge.js";
import { startConsoleServer } from "./consoleServer.js";

async function main(): Promise<void> {
  const config = loadBridgeConfig();
  const bridge = new CodexWeixinBridge(config);
  await bridge.init();

  console.log(`[codex-weixin] bridge started`);
  console.log(`[codex-weixin] state root: ${config.logRoot}`);
  console.log(`[codex-weixin] codex cwd: ${config.codexCwd}`);

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

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
