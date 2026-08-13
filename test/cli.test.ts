import { describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.js";
import { makeTestConfig } from "./testConfig.js";

describe("CLI", () => {
  it("shows help and version without loading runtime configuration", async () => {
    const output: string[] = [];
    const loadConfig = vi.fn(() => makeTestConfig("/unused"));

    expect(await runCli(["help"], { loadConfig, output: (message) => output.push(message) })).toBe(0);
    expect(await runCli(["version"], {
      loadConfig,
      output: (message) => output.push(message),
      version: () => "0.4.0"
    })).toBe(0);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(output.join("\n")).toContain("weixin-codex-bridge [command]");
    expect(output).toContain("0.4.0");
  });

  it("lists account sources without credentials", async () => {
    const output: string[] = [];
    expect(await runCli(["accounts"], {
      listAccounts: async () => [
        { accountId: "local-account", source: "bridge" },
        { accountId: "compat-account", source: "openclaw" }
      ],
      loadConfig: () => makeTestConfig("/unused"),
      output: (message) => output.push(message)
    })).toBe(0);

    expect(output).toEqual([
      "local-account\tbridge",
      "compat-account\topenclaw"
    ]);
  });

  it("never deletes an OpenClaw-compatible account", async () => {
    const removeAccount = vi.fn(async () => true);
    await expect(runCli(["logout", "compat-account"], {
      listAccounts: async () => [{ accountId: "compat-account", source: "openclaw" }],
      loadConfig: () => makeTestConfig("/unused"),
      removeAccount
    })).rejects.toThrow("never deleted");
    expect(removeAccount).not.toHaveBeenCalled();
  });

  it("uses the doctor result as its exit status", async () => {
    expect(await runCli(["doctor"], {
      doctor: () => ({ checks: [], ok: false }),
      loadConfig: () => makeTestConfig("/unused"),
      output: () => undefined
    })).toBe(1);
  });
});
