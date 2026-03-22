import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readVersion() {
  try {
    const pkgPath = path.resolve(__dirname, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(body, token) {
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(body, "utf-8")),
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

async function apiPost({ baseUrl, endpoint, body, token, timeoutMs }) {
  const url = new URL(endpoint, ensureTrailingSlash(baseUrl));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(body, token),
      body,
      signal: controller.signal,
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`${endpoint} ${res.status}: ${raw}`);
    }
    return raw;
  } finally {
    clearTimeout(timer);
  }
}

export function buildBaseInfo() {
  return {
    channel_version: readVersion(),
  };
}

export async function fetchQrCode({ baseUrl, botType }) {
  const url = new URL(
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    ensureTrailingSlash(baseUrl),
  );
  const res = await fetch(url);
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`get_bot_qrcode ${res.status}: ${raw}`);
  }
  return JSON.parse(raw);
}

export async function pollQrStatus({ baseUrl, qrcode, timeoutMs = 35_000 }) {
  const url = new URL(
    `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    ensureTrailingSlash(baseUrl),
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`get_qrcode_status ${res.status}: ${raw}`);
    }
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { status: "wait" };
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function getUpdates({
  baseUrl,
  token,
  getUpdatesBuf = "",
  timeoutMs = 35_000,
}) {
  try {
    const raw = await apiPost({
      baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: getUpdatesBuf,
        base_info: buildBaseInfo(),
      }),
      token,
      timeoutMs,
    });
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw error;
  }
}

export async function getConfig({ baseUrl, token, ilinkUserId, contextToken, timeoutMs = 10_000 }) {
  const raw = await apiPost({
    baseUrl,
    endpoint: "ilink/bot/getconfig",
    body: JSON.stringify({
      ilink_user_id: ilinkUserId,
      context_token: contextToken,
      base_info: buildBaseInfo(),
    }),
    token,
    timeoutMs,
  });
  return JSON.parse(raw);
}

export async function sendTyping({ baseUrl, token, body, timeoutMs = 10_000 }) {
  await apiPost({
    baseUrl,
    endpoint: "ilink/bot/sendtyping",
    body: JSON.stringify({
      ...body,
      base_info: buildBaseInfo(),
    }),
    token,
    timeoutMs,
  });
}

export async function sendTextMessage({
  baseUrl,
  token,
  toUserId,
  text,
  contextToken,
  timeoutMs = 15_000,
}) {
  const clientId = `wx-codex-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  await apiPost({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: text
          ? [
              {
                type: 1,
                text_item: { text },
              },
            ]
          : undefined,
      },
      base_info: buildBaseInfo(),
    }),
    token,
    timeoutMs,
  });
  return { clientId };
}
