import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadWeixinAccount } from "../src/accountStore.js";
import {
  fetchWeixinQrCode,
  loginWeixin,
  pollWeixinQrStatus
} from "../src/weixinLogin.js";
import { makeTestConfig } from "./testConfig.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Weixin QR login", () => {
  it("stores a confirmed account without reporting the QR payload or token", async () => {
    const root = await temporaryRoot();
    const config = makeTestConfig(root);
    const output: string[] = [];
    const rendered: string[] = [];

    const account = await loginWeixin(config, {
      fetchQrCode: async () => ({ qrcode: "opaque-qr-id", qrcodeContent: "private-qr-payload" }),
      pollQrStatus: async () => ({
        baseUrl: "https://ilinkai.weixin.qq.com",
        botId: "example@im.bot",
        botToken: "private-bot-token",
        status: "confirmed",
        userId: "placeholder-user"
      }),
      renderQr: async (content) => {
        rendered.push(content);
      },
      report: (message) => output.push(message)
    });

    expect(rendered).toEqual(["private-qr-payload"]);
    expect(output.join("\n")).not.toContain("private-qr-payload");
    expect(output.join("\n")).not.toContain("private-bot-token");
    expect(account.accountId).toBe("example-im-bot");
    expect(await loadWeixinAccount(config)).toEqual(account);
  });

  it("refreshes an expired QR code and stops at the configured limit", async () => {
    const root = await temporaryRoot();
    const fetchQrCode = vi.fn(async () => ({ qrcode: "opaque", qrcodeContent: "content" }));

    await expect(loginWeixin(makeTestConfig(root), {
      fetchQrCode,
      pollQrStatus: async () => ({ status: "expired" }),
      qrLimit: 2,
      renderQr: async () => undefined,
      report: () => undefined
    })).rejects.toThrow("expired too many times");
    expect(fetchQrCode).toHaveBeenCalledTimes(2);
  });

  it("caps each network request at the remaining overall login deadline", async () => {
    const root = await temporaryRoot();
    let clock = 1_000;
    const fetchTimeouts: Array<number | undefined> = [];

    await expect(loginWeixin(makeTestConfig(root), {
      fetchQrCode: async (_baseUrl, _botType, timeoutMs) => {
        fetchTimeouts.push(timeoutMs);
        clock += 50;
        return { qrcode: "opaque", qrcodeContent: "content" };
      },
      loginTimeoutMs: 50,
      now: () => clock,
      renderQr: async () => undefined,
      report: () => undefined
    })).rejects.toThrow("timed out before confirmation");

    expect(fetchTimeouts).toEqual([50]);
  });

  it("does not echo a sensitive response body in HTTP errors", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ bot_token: "must-not-appear" }),
      { status: 500 }
    ));

    await expect(fetchWeixinQrCode(
      "https://ilinkai.weixin.qq.com",
      "3",
      fetchImpl
    )).rejects.not.toThrow("must-not-appear");
  });

  it("maps a confirmed status response and validates required credentials", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      baseurl: "https://ilinkai.weixin.qq.com",
      bot_token: "placeholder-token",
      ilink_bot_id: "placeholder@im.bot",
      ilink_user_id: "placeholder-user",
      status: "confirmed"
    }), { status: 200 }));

    await expect(pollWeixinQrStatus(
      "https://ilinkai.weixin.qq.com",
      "opaque-qr",
      fetchImpl
    )).resolves.toEqual({
      baseUrl: "https://ilinkai.weixin.qq.com",
      botId: "placeholder@im.bot",
      botToken: "placeholder-token",
      status: "confirmed",
      userId: "placeholder-user"
    });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "weixin-login-test-"));
  temporaryRoots.push(root);
  return root;
}
