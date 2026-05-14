import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { BridgeConfig } from "./config.js";
import type { WeixinAccount } from "./types.js";

interface StoredAccount {
  baseUrl?: string;
  token?: string;
  userId?: string;
}

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";

function accountsRoot(config: BridgeConfig): string {
  return path.join(config.openclawStateRoot, "openclaw-weixin");
}

async function readJson<T>(filePath: string): Promise<T | null> {
  if (!existsSync(filePath)) {
    return null;
  }

  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export async function listWeixinAccountIds(config: BridgeConfig): Promise<string[]> {
  const indexPath = path.join(accountsRoot(config), "accounts.json");
  const parsed = await readJson<unknown>(indexPath);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

export async function loadWeixinAccount(config: BridgeConfig): Promise<WeixinAccount> {
  const accountIds = await listWeixinAccountIds(config);
  const accountId = config.accountId ?? accountIds[0];
  if (!accountId) {
    throw new Error(`No Weixin account found under ${accountsRoot(config)}. Run the existing OpenClaw Weixin QR login first.`);
  }

  const accountPath = path.join(accountsRoot(config), "accounts", `${accountId}.json`);
  const stored = await readJson<StoredAccount>(accountPath);
  if (!stored?.token?.trim()) {
    throw new Error(`Weixin account ${accountId} has no token at ${accountPath}.`);
  }

  return {
    accountId,
    baseUrl: stored.baseUrl?.trim() || DEFAULT_BASE_URL,
    token: stored.token.trim(),
    userId: stored.userId
  };
}
