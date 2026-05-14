import { createHash } from "node:crypto";

function sanitizeId(value: string): string {
  const cleaned = value
    .trim()
    .replace(/@/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return cleaned || "unknown";
}

export function createSessionKey(accountId: string, peerId: string): string {
  const hash = createHash("sha256")
    .update(`${accountId}\0${peerId}`)
    .digest("hex")
    .slice(0, 12);
  const account = sanitizeId(accountId).slice(0, 48);
  const peer = sanitizeId(peerId).slice(0, 72);

  return `weixin_${account}__${peer}_${hash}`;
}
