import QRCode from "qrcode";
import qrcodeTerminal from "qrcode-terminal";

import { persistRuntimeConfig } from "./config.mjs";
import { info, warn } from "./log.mjs";
import { LOGIN_QR_FILE, ensureLocalDir } from "./paths.mjs";
import { saveAccount } from "./state.mjs";
import { fetchQrCode, pollQrStatus } from "./weixin-api.mjs";

const QR_LOGIN_TIMEOUT_MS = 8 * 60_000;
const QR_REFRESH_LIMIT = 3;

function renderQr(qrcodeUrl) {
  return new Promise((resolve) => {
    qrcodeTerminal.generate(qrcodeUrl, { small: true }, (output) => {
      process.stdout.write(`${output}\n`);
      resolve();
    });
  });
}

async function writeQrPreview(qrcodeUrl) {
  ensureLocalDir();
  await QRCode.toFile(LOGIN_QR_FILE, qrcodeUrl, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 512,
  });
  return LOGIN_QR_FILE;
}

export async function loginWeixin(config) {
  persistRuntimeConfig(config);

  let refreshCount = 0;
  let current = await fetchQrCode({
    baseUrl: config.baseUrl,
    botType: config.botType,
  });
  let startedAt = Date.now();

  for (;;) {
    refreshCount += 1;
    info("使用微信扫描以下二维码，以完成 standalone bridge 登录");
    const qrImagePath = await writeQrPreview(current.qrcode_img_content);
    await renderQr(current.qrcode_img_content);
    console.log(`二维码图片: ${qrImagePath}`);
    console.log(`二维码链接: ${current.qrcode_img_content}`);
    console.log("等待连接结果...");

    for (;;) {
      const status = await pollQrStatus({
        baseUrl: config.baseUrl,
        qrcode: current.qrcode,
      });

      if (status.status === "wait") {
        process.stdout.write(".");
        continue;
      }
      if (status.status === "scaned") {
        process.stdout.write("\n👀 已扫码，请在微信里确认。\n");
        continue;
      }
      if (status.status === "confirmed") {
        process.stdout.write("\n✅ 与微信连接成功。\n");
        const account = {
          botToken: status.bot_token,
          accountId: status.ilink_bot_id?.replace("@im.bot", "-im-bot"),
          rawAccountId: status.ilink_bot_id,
          userId: status.ilink_user_id,
          baseUrl: status.baseurl || config.baseUrl,
          qrcodeUrl: current.qrcode_img_content,
        };
        saveAccount(account);
        return account;
      }
      if (status.status === "expired") {
        break;
      }
    }

    if (Date.now() - startedAt > QR_LOGIN_TIMEOUT_MS || refreshCount >= QR_REFRESH_LIMIT) {
      throw new Error("登录超时：二维码多次过期。");
    }

    warn("二维码已过期，正在刷新...");
    current = await fetchQrCode({
      baseUrl: config.baseUrl,
      botType: config.botType,
    });
  }
}
