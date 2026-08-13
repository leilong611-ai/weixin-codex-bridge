import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  bridgeAccountDirectory,
  bridgeAccountsRoot,
  listWeixinAccounts,
  loadWeixinAccount,
  removeLocalWeixinAccount,
  saveLocalWeixinAccount
} from "../src/accountStore.js";
import { makeTestConfig } from "./testConfig.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("local Weixin account storage", () => {
  it("writes credentials atomically with private POSIX permissions", async () => {
    const root = await temporaryRoot();
    const config = makeTestConfig(root);
    await saveLocalWeixinAccount(config, {
      accountId: "example-im-bot",
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "placeholder-token-value",
      userId: "placeholder-user"
    });

    const accountPath = path.join(bridgeAccountsRoot(config), "accounts", "example-im-bot.json");
    const stored = JSON.parse(await readFile(accountPath, "utf8"));
    expect(stored).toEqual({
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "placeholder-token-value",
      userId: "placeholder-user"
    });
    expect(await listWeixinAccounts(config)).toEqual([
      { accountId: "example-im-bot", source: "bridge" }
    ]);

    if (process.platform !== "win32") {
      expect((await stat(accountPath)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(accountPath))).mode & 0o777).toBe(0o700);
      expect((await stat(bridgeAccountDirectory(config))).mode & 0o777).toBe(0o700);
    }
  });

  it("prefers bridge-managed state while retaining OpenClaw compatibility", async () => {
    const root = await temporaryRoot();
    const config = makeTestConfig(root);
    await writeOpenclawAccount(config.openclawStateRoot, "shared-account", "openclaw-token");
    await writeOpenclawAccount(config.openclawStateRoot, "openclaw-only", "compatibility-token", [
      "shared-account",
      "openclaw-only"
    ]);
    await saveLocalWeixinAccount(config, {
      accountId: "shared-account",
      baseUrl: "https://local.example.test",
      token: "local-token"
    });

    expect(await listWeixinAccounts(config)).toEqual([
      { accountId: "shared-account", source: "bridge" },
      { accountId: "openclaw-only", source: "openclaw" }
    ]);
    expect(await loadWeixinAccount(config)).toMatchObject({
      accountId: "shared-account",
      baseUrl: "https://local.example.test",
      token: "local-token"
    });
    expect(await loadWeixinAccount({ ...config, accountId: "openclaw-only" })).toMatchObject({
      accountId: "openclaw-only",
      token: "compatibility-token"
    });
  });

  it("removes only bridge-managed state", async () => {
    const root = await temporaryRoot();
    const config = makeTestConfig(root);
    await writeOpenclawAccount(config.openclawStateRoot, "compat-account", "compatibility-token");
    await saveLocalWeixinAccount(config, {
      accountId: "local-account",
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "local-token"
    });

    expect(await removeLocalWeixinAccount(config, "local-account")).toBe(true);
    expect(await removeLocalWeixinAccount(config, "compat-account")).toBe(false);
    expect(await listWeixinAccounts(config)).toEqual([
      { accountId: "compat-account", source: "openclaw" }
    ]);
  });

  it("keeps simultaneous account saves without a shared mutable index", async () => {
    const root = await temporaryRoot();
    const config = makeTestConfig(root);

    await Promise.all(["account-a", "account-b"].map(async (accountId) => {
      await saveLocalWeixinAccount(config, {
        accountId,
        baseUrl: "https://ilinkai.weixin.qq.com",
        token: `${accountId}-token`
      });
    }));

    expect(await listWeixinAccounts(config)).toEqual([
      { accountId: "account-a", source: "bridge" },
      { accountId: "account-b", source: "bridge" }
    ]);
  });

  it("keeps concurrent save/logout outcomes consistent with credential files", async () => {
    const root = await temporaryRoot();
    const config = makeTestConfig(root);
    await saveLocalWeixinAccount(config, {
      accountId: "racing-account",
      baseUrl: "https://ilinkai.weixin.qq.com",
      token: "initial-token"
    });

    await Promise.allSettled([
      saveLocalWeixinAccount(config, {
        accountId: "racing-account",
        baseUrl: "https://ilinkai.weixin.qq.com",
        token: "replacement-token"
      }),
      removeLocalWeixinAccount(config, "racing-account")
    ]);

    const listed = await listWeixinAccounts(config);
    if (listed.length === 0) {
      await expect(loadWeixinAccount(config)).rejects.toThrow("No Weixin account found");
    } else {
      expect(listed).toEqual([{ accountId: "racing-account", source: "bridge" }]);
      await expect(loadWeixinAccount(config)).resolves.toMatchObject({
        accountId: "racing-account",
        token: "replacement-token"
      });
    }
  });

  it("rejects insecure endpoints in local and OpenClaw-compatible stores", async () => {
    const root = await temporaryRoot();
    const config = makeTestConfig(root);

    await expect(saveLocalWeixinAccount(config, {
      accountId: "local-account",
      baseUrl: "http://ilinkai.weixin.qq.com",
      token: "placeholder-token"
    })).rejects.toThrow("must use HTTPS");

    await writeOpenclawAccount(
      config.openclawStateRoot,
      "compat-account",
      "compatibility-token",
      ["compat-account"],
      "http://ilinkai.weixin.qq.com"
    );
    await expect(loadWeixinAccount(config)).rejects.toThrow("must use HTTPS");
  });

  it("rejects path-like account IDs", async () => {
    const root = await temporaryRoot();
    const config = makeTestConfig(root, { accountId: "../outside" });

    await expect(loadWeixinAccount(config)).rejects.toThrow("Invalid Weixin account ID");
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "account-store-test-"));
  temporaryRoots.push(root);
  return root;
}

async function writeOpenclawAccount(
  stateRoot: string,
  accountId: string,
  token: string,
  accountIds: string[] = [accountId],
  baseUrl = "https://ilinkai.weixin.qq.com"
): Promise<void> {
  const root = path.join(stateRoot, "openclaw-weixin");
  await mkdir(path.join(root, "accounts"), { recursive: true });
  await writeFile(path.join(root, "accounts.json"), JSON.stringify(accountIds));
  await writeFile(path.join(root, "accounts", `${accountId}.json`), JSON.stringify({
    baseUrl,
    token
  }));
}
