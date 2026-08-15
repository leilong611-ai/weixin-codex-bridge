import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BridgeConfig } from "./config.js";
import type { WeixinAccount } from "./types.js";
import { normalizeWeixinEndpoint } from "./weixinEndpoint.js";

interface StoredAccount {
  baseUrl?: string;
  token?: string;
  userId?: string;
}

export interface WeixinAccountSummary {
  accountId: string;
  source: "bridge" | "openclaw";
}

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const SAFE_ACCOUNT_ID = /^[A-Za-z0-9._@-]{1,128}$/;

export function bridgeAccountsRoot(config: BridgeConfig): string {
  return path.join(config.logRoot, "weixin-accounts");
}

export function bridgeAccountDirectory(config: BridgeConfig): string {
  return path.join(bridgeAccountsRoot(config), "accounts");
}

export function openclawAccountsRoot(config: BridgeConfig): string {
  return path.join(config.openclawStateRoot, "openclaw-weixin");
}

export function openclawAccountIndexPath(config: BridgeConfig): string {
  return path.join(openclawAccountsRoot(config), "accounts.json");
}

function assertSafeAccountId(accountId: string): void {
  if (!SAFE_ACCOUNT_ID.test(accountId) || accountId === "." || accountId === "..") {
    throw new Error("Invalid Weixin account ID.");
  }
}

async function readJson<T>(filePath: string): Promise<T | null> {
  if (!existsSync(filePath)) {
    return null;
  }

  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function readAccountIds(indexPath: string): Promise<string[]> {
  const parsed = await readJson<unknown>(indexPath);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter((entry): entry is string =>
    typeof entry === "string" && SAFE_ACCOUNT_ID.test(entry) && entry !== "." && entry !== ".."
  );
}

async function listBridgeAccountIds(config: BridgeConfig): Promise<string[]> {
  try {
    const entries = await readdir(bridgeAccountDirectory(config), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -".json".length))
      .filter((accountId) => SAFE_ACCOUNT_ID.test(accountId) && accountId !== "." && accountId !== "..")
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function setPrivateMode(filePath: string, mode: number): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(filePath, mode);
  }
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  const parent = path.dirname(filePath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await setPrivateMode(parent, 0o700);

  const temporaryPath = path.join(parent, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await setPrivateMode(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
    await setPrivateMode(filePath, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function listWeixinAccounts(config: BridgeConfig): Promise<WeixinAccountSummary[]> {
  const localIds = await listBridgeAccountIds(config);
  const openclawIds = await readAccountIds(openclawAccountIndexPath(config));
  const summaries: WeixinAccountSummary[] = localIds.map((accountId) => ({
    accountId,
    source: "bridge"
  }));
  const seen = new Set(localIds);

  for (const accountId of openclawIds) {
    if (!seen.has(accountId)) {
      summaries.push({ accountId, source: "openclaw" });
      seen.add(accountId);
    }
  }

  return summaries;
}

export async function listWeixinAccountIds(config: BridgeConfig): Promise<string[]> {
  return (await listWeixinAccounts(config)).map(({ accountId }) => accountId);
}

export async function saveLocalWeixinAccount(
  config: BridgeConfig,
  account: WeixinAccount
): Promise<void> {
  assertSafeAccountId(account.accountId);
  if (!account.token.trim()) {
    throw new Error("Cannot save a Weixin account without a token.");
  }

  const accountPath = path.join(bridgeAccountDirectory(config), `${account.accountId}.json`);
  await writePrivateJson(accountPath, {
    baseUrl: normalizeWeixinEndpoint(account.baseUrl.trim() || DEFAULT_BASE_URL),
    token: account.token.trim(),
    userId: account.userId
  });
}

export async function removeLocalWeixinAccount(
  config: BridgeConfig,
  accountId: string
): Promise<boolean> {
  assertSafeAccountId(accountId);
  const accountPath = path.join(bridgeAccountDirectory(config), `${accountId}.json`);
  try {
    await unlink(accountPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function loadStoredAccount(
  root: string,
  accountId: string
): Promise<WeixinAccount | null> {
  const accountPath = path.join(root, "accounts", `${accountId}.json`);
  const stored = await readJson<StoredAccount>(accountPath);
  if (stored == null) {
    return null;
  }
  if (!stored.token?.trim()) {
    throw new Error(`Weixin account ${accountId} has no token in its account store.`);
  }

  return {
    accountId,
    baseUrl: normalizeWeixinEndpoint(stored.baseUrl?.trim() || DEFAULT_BASE_URL),
    token: stored.token.trim(),
    userId: stored.userId
  };
}

export async function loadWeixinAccount(config: BridgeConfig): Promise<WeixinAccount> {
  const summaries = await listWeixinAccounts(config);
  const accountId = config.accountId ?? summaries[0]?.accountId;
  if (!accountId) {
    throw new Error(
      "No Weixin account found. Run `weixin-codex-bridge login`, or provide an existing OpenClaw Weixin state directory."
    );
  }
  assertSafeAccountId(accountId);

  for (const root of [bridgeAccountsRoot(config), openclawAccountsRoot(config)]) {
    const account = await loadStoredAccount(root, accountId);
    if (account) {
      return account;
    }
  }

  throw new Error(`Weixin account ${accountId} was listed but its account file was not found.`);
}
