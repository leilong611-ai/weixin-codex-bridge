import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import type { BridgeConfig } from "./config.js";
import { MessageItemType, MessageState, MessageType, type GetUpdatesResp, type SendMessageReq, type WeixinAccount } from "./types.js";

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function buildClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((piece) => Number.parseInt(piece, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf8").toString("base64");
}

async function loadRouteTag(config: BridgeConfig, accountId: string): Promise<string | undefined> {
  if (!existsSync(config.openclawConfigPath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(await readFile(config.openclawConfigPath, "utf8")) as {
      channels?: Record<string, {
        routeTag?: number | string;
        accounts?: Record<string, { routeTag?: number | string }>;
      }>;
    };
    const section = parsed.channels?.["openclaw-weixin"];
    const accountTag = section?.accounts?.[accountId]?.routeTag;
    const routeTag = accountTag ?? section?.routeTag;
    return routeTag == null ? undefined : String(routeTag);
  } catch {
    return undefined;
  }
}

export class WeixinApi {
  constructor(
    private readonly config: BridgeConfig,
    private readonly account: WeixinAccount
  ) {}

  async getUpdates(getUpdatesBuf: string, timeoutMs: number): Promise<GetUpdatesResp> {
    const body = JSON.stringify({
      get_updates_buf: getUpdatesBuf,
      base_info: this.baseInfo()
    });
    const raw = await this.post("ilink/bot/getupdates", body, timeoutMs, "getUpdates");
    return JSON.parse(raw) as GetUpdatesResp;
  }

  async sendText(params: { to: string; text: string; contextToken?: string }): Promise<string> {
    const clientId = `codex-weixin-${Date.now()}-${randomBytes(4).toString("hex")}`;
    const body: SendMessageReq = {
      msg: {
        from_user_id: "",
        to_user_id: params.to,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: params.text
          ? [{ type: MessageItemType.TEXT, text_item: { text: params.text } }]
          : undefined,
        context_token: params.contextToken
      }
    };

    await this.post("ilink/bot/sendmessage", JSON.stringify({ ...body, base_info: this.baseInfo() }), 15_000, "sendMessage");
    return clientId;
  }

  private baseInfo(): { channel_version: string } {
    return { channel_version: this.config.weixinChannelVersion };
  }

  private async headers(body: string): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.account.token}`,
      AuthorizationType: "ilink_bot_token",
      "Content-Length": String(Buffer.byteLength(body, "utf8")),
      "X-WECHAT-UIN": randomWechatUin(),
      "iLink-App-Id": "bot",
      "iLink-App-ClientVersion": String(buildClientVersion(this.config.weixinChannelVersion))
    };
    const routeTag = await loadRouteTag(this.config, this.account.accountId);
    if (routeTag) {
      headers.SKRouteTag = routeTag;
    }
    return headers;
  }

  private async post(endpoint: string, body: string, timeoutMs: number, label: string): Promise<string> {
    const url = new URL(endpoint, ensureTrailingSlash(this.account.baseUrl));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: await this.headers(body),
        body,
        signal: controller.signal
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(`${label} failed with HTTP ${response.status}: ${raw}`);
      }

      return raw;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError" && label === "getUpdates") {
        return JSON.stringify({ ret: 0, msgs: [] });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
