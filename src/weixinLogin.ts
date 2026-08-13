import qrcodeTerminal from "qrcode-terminal";

import { saveLocalWeixinAccount } from "./accountStore.js";
import type { BridgeConfig } from "./config.js";
import type { WeixinAccount } from "./types.js";
import { normalizeWeixinEndpoint } from "./weixinEndpoint.js";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_BOT_TYPE = "3";
const DEFAULT_LOGIN_TIMEOUT_MS = 8 * 60_000;
const DEFAULT_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_QR_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_QR_LIMIT = 3;

export interface WeixinQrCode {
  qrcode: string;
  qrcodeContent: string;
}

export type WeixinQrStatus =
  | { status: "wait" | "scaned" | "expired" }
  | {
      baseUrl?: string;
      botToken: string;
      botId: string;
      status: "confirmed";
      userId?: string;
    };

type FetchLike = typeof fetch;

export interface LoginWeixinOptions {
  baseUrl?: string;
  botType?: string;
  fetchQrCode?: (baseUrl: string, botType: string, timeoutMs?: number) => Promise<WeixinQrCode>;
  loginTimeoutMs?: number;
  now?: () => number;
  pollDelayMs?: number;
  pollQrStatus?: (baseUrl: string, qrcode: string, timeoutMs?: number) => Promise<WeixinQrStatus>;
  qrLimit?: number;
  renderQr?: (content: string) => Promise<void>;
  report?: (message: string) => void;
  sleep?: (delayMs: number) => Promise<void>;
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
      throw new Error();
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${label} returned an invalid response.`);
  }
}

export async function fetchWeixinQrCode(
  baseUrl: string,
  botType: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs = DEFAULT_QR_REQUEST_TIMEOUT_MS
): Promise<WeixinQrCode> {
  const url = new URL(
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    `${normalizeWeixinEndpoint(baseUrl)}/`
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Weixin QR request failed with HTTP ${response.status}.`);
    }

    const parsed = parseJsonObject(raw, "Weixin QR request");
    if (typeof parsed.qrcode !== "string" || typeof parsed.qrcode_img_content !== "string") {
      throw new Error("Weixin QR request did not return a usable QR code.");
    }
    return {
      qrcode: parsed.qrcode,
      qrcodeContent: parsed.qrcode_img_content
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Weixin QR request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function pollWeixinQrStatus(
  baseUrl: string,
  qrcode: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs = DEFAULT_POLL_TIMEOUT_MS
): Promise<WeixinQrStatus> {
  const url = new URL(
    `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    `${normalizeWeixinEndpoint(baseUrl)}/`
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Weixin QR status failed with HTTP ${response.status}.`);
    }

    const parsed = parseJsonObject(raw, "Weixin QR status");
    if (parsed.status === "wait" || parsed.status === "scaned" || parsed.status === "expired") {
      return { status: parsed.status };
    }
    if (parsed.status !== "confirmed") {
      throw new Error("Weixin QR status returned an unsupported state.");
    }
    if (typeof parsed.bot_token !== "string" || typeof parsed.ilink_bot_id !== "string") {
      throw new Error("Weixin QR confirmation did not include the required account credentials.");
    }

    return {
      baseUrl: typeof parsed.baseurl === "string" ? parsed.baseurl : undefined,
      botId: parsed.ilink_bot_id,
      botToken: parsed.bot_token,
      status: "confirmed",
      userId: typeof parsed.ilink_user_id === "string" ? parsed.ilink_user_id : undefined
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { status: "wait" };
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function renderTerminalQr(content: string): Promise<void> {
  await new Promise<void>((resolve) => {
    qrcodeTerminal.generate(content, { small: true }, (output) => {
      process.stdout.write(`${output}\n`);
      resolve();
    });
  });
}

function accountIdFromBotId(botId: string): string {
  const accountId = botId.replace(/@im\.bot$/, "-im-bot");
  if (!accountId || accountId === botId && botId.includes("/")) {
    throw new Error("Weixin QR confirmation returned an invalid account ID.");
  }
  return accountId;
}

export async function loginWeixin(
  config: BridgeConfig,
  options: LoginWeixinOptions = {}
): Promise<WeixinAccount> {
  const baseUrl = normalizeWeixinEndpoint(
    options.baseUrl ?? process.env.CODEX_WEIXIN_BASE_URL ?? DEFAULT_BASE_URL
  );
  const botType = options.botType ?? process.env.CODEX_WEIXIN_BOT_TYPE ?? DEFAULT_BOT_TYPE;
  const fetchQrCode = options.fetchQrCode ?? ((endpoint, type, timeoutMs) =>
    fetchWeixinQrCode(endpoint, type, fetch, timeoutMs));
  const pollQrStatus = options.pollQrStatus ?? ((endpoint, qrcode, timeoutMs) =>
    pollWeixinQrStatus(endpoint, qrcode, fetch, timeoutMs));
  const renderQr = options.renderQr ?? renderTerminalQr;
  const report = options.report ?? console.log;
  const now = options.now ?? Date.now;
  const pollDelayMs = options.pollDelayMs ?? 1_000;
  const sleep = options.sleep ?? ((delayMs: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const startedAt = now();
  const loginTimeoutMs = options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const qrLimit = options.qrLimit ?? DEFAULT_QR_LIMIT;

  function remainingTime(): number {
    const remaining = loginTimeoutMs - (now() - startedAt);
    if (remaining <= 0) {
      throw new Error("Weixin login timed out before confirmation.");
    }
    return remaining;
  }

  for (let attempt = 1; attempt <= qrLimit; attempt += 1) {
    const qr = await fetchQrCode(
      baseUrl,
      botType,
      Math.min(DEFAULT_QR_REQUEST_TIMEOUT_MS, remainingTime())
    );
    remainingTime();
    report("Scan this QR code in WeChat. The QR payload is not written to disk or logs.");
    await renderQr(qr.qrcodeContent);
    let scanReported = false;

    for (;;) {
      const status = await pollQrStatus(
        baseUrl,
        qr.qrcode,
        Math.min(DEFAULT_POLL_TIMEOUT_MS, remainingTime())
      );
      if (status.status === "wait") {
        await sleep(Math.min(pollDelayMs, remainingTime()));
        continue;
      }
      if (status.status === "scaned") {
        if (!scanReported) {
          report("QR code scanned. Confirm the login in WeChat.");
          scanReported = true;
        }
        await sleep(Math.min(pollDelayMs, remainingTime()));
        continue;
      }
      if (status.status === "expired") {
        if (attempt < qrLimit) {
          report("QR code expired. Requesting a new one.");
        }
        break;
      }
      if (status.status !== "confirmed") {
        throw new Error("Weixin QR status returned an unsupported state.");
      }

      const account: WeixinAccount = {
        accountId: accountIdFromBotId(status.botId),
        baseUrl: normalizeWeixinEndpoint(status.baseUrl ?? baseUrl),
        token: status.botToken,
        userId: status.userId
      };
      await saveLocalWeixinAccount(config, account);
      report(`Weixin account ${account.accountId} saved to the private bridge state directory.`);
      return account;
    }
  }

  throw new Error("Weixin login failed because the QR code expired too many times.");
}
