import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";

import { loadBridgeConfig } from "../src/config.js";

const originalEnv = { ...process.env };

describe("loadBridgeConfig", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("uses a Codex CLI model supported by the installed app by default", () => {
    delete process.env.CODEX_WEIXIN_MODEL;
    process.env.CODEX_WEIXIN_AUTO_DESKTOP_SESSION = "false";

    expect(loadBridgeConfig().codexModel).toBe("gpt-5.4-mini");
  });

  it("defaults bridge state to the OS-local app state directory", () => {
    delete process.env.CODEX_WEIXIN_LOG_ROOT;
    delete process.env.CODEX_WEIXIN_STATE_ROOT;
    process.env.CODEX_WEIXIN_AUTO_DESKTOP_SESSION = "false";
    process.env.LOCALAPPDATA = "C:\\Users\\roy\\AppData\\Local";

    const expected = process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA, "codex-weixin-bridge")
      : path.join(os.homedir(), ".local", "state", "codex-weixin-bridge");

    expect(loadBridgeConfig().logRoot).toBe(expected);
  });

  it("lets bridge state environment variables override the OS-local default", () => {
    process.env.CODEX_WEIXIN_AUTO_DESKTOP_SESSION = "false";
    process.env.CODEX_WEIXIN_STATE_ROOT = "D:\\bridge-state";
    delete process.env.CODEX_WEIXIN_LOG_ROOT;

    expect(loadBridgeConfig().logRoot).toBe("D:\\bridge-state");

    process.env.CODEX_WEIXIN_LOG_ROOT = "D:\\bridge-logs";
    expect(loadBridgeConfig().logRoot).toBe("D:\\bridge-logs");
  });

  it("lets CODEX_WEIXIN_MODEL override the bridge default", () => {
    process.env.CODEX_WEIXIN_MODEL = "gpt-5.4";
    process.env.CODEX_WEIXIN_AUTO_DESKTOP_SESSION = "false";

    expect(loadBridgeConfig().codexModel).toBe("gpt-5.4");
  });

  it("keeps Codex CLI fallback disabled unless explicitly enabled", () => {
    delete process.env.CODEX_WEIXIN_CLI_FALLBACK;
    process.env.CODEX_WEIXIN_AUTO_DESKTOP_SESSION = "false";

    expect(loadBridgeConfig().cliFallbackEnabled).toBe(false);

    process.env.CODEX_WEIXIN_CLI_FALLBACK = "true";
    expect(loadBridgeConfig().cliFallbackEnabled).toBe(true);
  });

  it("keeps Desktop UI delivery single-lane even when max parallel is configured", () => {
    process.env.CODEX_WEIXIN_DELIVERY_MODE = "desktop-ui";
    process.env.CODEX_WEIXIN_MAX_PARALLEL = "5";
    process.env.CODEX_WEIXIN_AUTO_DESKTOP_SESSION = "false";

    expect(loadBridgeConfig().maxParallelRuns).toBe(1);
  });

  it("lets codex-cli delivery process multiple Weixin sessions in parallel", () => {
    process.env.CODEX_WEIXIN_DELIVERY_MODE = "codex-cli";
    process.env.CODEX_WEIXIN_MAX_PARALLEL = "4";
    process.env.CODEX_WEIXIN_AUTO_DESKTOP_SESSION = "false";

    expect(loadBridgeConfig().maxParallelRuns).toBe(4);
  });
});
