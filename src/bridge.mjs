import { promptCodex, resetSession } from "./codex-runner.mjs";
import { info, warn, error } from "./log.mjs";
import { loadAccount, loadSyncCursor, saveSyncCursor } from "./state.mjs";
import {
  getConfig,
  getUpdates,
  sendTextMessage,
  sendTyping,
} from "./weixin-api.mjs";
import {
  extractTextFromMessage,
  replyForUnsupportedMessage,
  splitReply,
} from "./text.mjs";

const SESSION_EXPIRED_ERRCODE = -14;

async function safeTypingStart(account, message) {
  try {
    const config = await getConfig({
      baseUrl: account.baseUrl,
      token: account.botToken,
      ilinkUserId: message.from_user_id,
      contextToken: message.context_token,
    });
    if (!config.typing_ticket) {
      return null;
    }
    await sendTyping({
      baseUrl: account.baseUrl,
      token: account.botToken,
      body: {
        ilink_user_id: message.from_user_id,
        typing_ticket: config.typing_ticket,
        status: 1,
      },
    });
    return config.typing_ticket;
  } catch (typingError) {
    warn(`typing start failed: ${String(typingError)}`);
    return null;
  }
}

async function safeTypingStop(account, message, typingTicket) {
  if (!typingTicket) {
    return;
  }
  try {
    await sendTyping({
      baseUrl: account.baseUrl,
      token: account.botToken,
      body: {
        ilink_user_id: message.from_user_id,
        typing_ticket: typingTicket,
        status: 2,
      },
    });
  } catch (typingError) {
    warn(`typing stop failed: ${String(typingError)}`);
  }
}

async function sendReply(account, message, text) {
  for (const chunk of splitReply(text)) {
    await sendTextMessage({
      baseUrl: account.baseUrl,
      token: account.botToken,
      toUserId: message.from_user_id,
      contextToken: message.context_token,
      text: chunk,
    });
  }
}

async function handleMessage(config, account, message) {
  if (message.message_type === 2) {
    return;
  }
  if (!message.from_user_id || !message.context_token) {
    return;
  }

  const unsupportedReply = replyForUnsupportedMessage(message);
  if (unsupportedReply) {
    await sendReply(account, message, unsupportedReply);
    return;
  }

  const text = extractTextFromMessage(message);
  if (!text) {
    return;
  }

  if (text === "/new" || text === "/reset") {
    await resetSession(config, message.from_user_id);
    await sendReply(account, message, "已重置当前微信用户对应的 Codex 会话。");
    return;
  }

  const typingTicket = await safeTypingStart(account, message);
  try {
    const reply = await promptCodex(config, message.from_user_id, text);
    await sendReply(account, message, reply || "空回复。");
  } catch (promptError) {
    error(`Codex prompt failed: ${String(promptError)}`);
    await sendReply(account, message, `Codex 调用失败：${String(promptError).slice(0, 500)}`);
  } finally {
    await safeTypingStop(account, message, typingTicket);
  }
}

function isApiError(resp) {
  return (
    (resp?.ret !== undefined && resp.ret !== 0) ||
    (resp?.errcode !== undefined && resp.errcode !== 0)
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runBridge(config) {
  const account = loadAccount();
  if (!account?.botToken || !account?.baseUrl) {
    throw new Error("No linked Weixin account. Run login first.");
  }

  info(`Starting standalone bridge for ${account.rawAccountId || account.accountId}`);
  let getUpdatesBuf = loadSyncCursor();
  let consecutiveFailures = 0;

  for (;;) {
    try {
      const resp = await getUpdates({
        baseUrl: account.baseUrl,
        token: account.botToken,
        getUpdatesBuf,
        timeoutMs: config.longPollTimeoutMs,
      });

      if (resp?.longpolling_timeout_ms > 0) {
        config.longPollTimeoutMs = resp.longpolling_timeout_ms;
      }

      if (isApiError(resp)) {
        if (resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE) {
          throw new Error("Weixin session expired. Please run login again.");
        }
        throw new Error(
          `getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg || ""}`,
        );
      }

      consecutiveFailures = 0;
      if (typeof resp.get_updates_buf === "string" && resp.get_updates_buf) {
        getUpdatesBuf = resp.get_updates_buf;
        saveSyncCursor(getUpdatesBuf);
      }

      for (const message of resp.msgs ?? []) {
        await handleMessage(config, account, message);
      }
    } catch (loopError) {
      consecutiveFailures += 1;
      error(`bridge loop error: ${String(loopError)}`);
      await sleep(Math.min(config.retryDelayMs * consecutiveFailures, 30_000));
    }
  }
}
