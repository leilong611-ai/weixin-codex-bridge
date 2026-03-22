export function extractTextFromMessage(message) {
  const parts = [];
  for (const item of message?.item_list ?? []) {
    if (item?.type === 1 && item.text_item?.text) {
      parts.push(item.text_item.text);
      continue;
    }
    if (item?.type === 3 && item.voice_item?.text) {
      parts.push(item.voice_item.text);
    }
  }
  return parts.join("\n").trim();
}

export function replyForUnsupportedMessage(message) {
  const hasText = Boolean(extractTextFromMessage(message));
  if (hasText) {
    return null;
  }
  return "当前 standalone bridge 只支持文本消息。";
}

export function markdownToPlainText(text) {
  let result = text ?? "";
  result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code) => code.trim());
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  result = result.replace(/^\|[\s:|-]+\|$/gm, "");
  result = result.replace(/^\|(.+)\|$/gm, (_, inner) =>
    inner
      .split("|")
      .map((cell) => cell.trim())
      .join("  "),
  );
  result = result
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`~>-]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return result;
}

export function splitReply(text, maxChars = 3200) {
  const input = (text ?? "").trim();
  if (!input) {
    return ["空回复。"];
  }
  if (input.length <= maxChars) {
    return [input];
  }

  const chunks = [];
  let remaining = input;
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf("\n", maxChars);
    if (cut < maxChars * 0.5) {
      cut = remaining.lastIndexOf(" ", maxChars);
    }
    if (cut < maxChars * 0.5) {
      cut = maxChars;
    }
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

export function sanitizeSessionName(raw) {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 80);
}
