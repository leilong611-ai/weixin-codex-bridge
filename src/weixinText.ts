import { MessageItemType, type MessageItem, type WeixinMessage } from "./types.js";

function isMediaItem(item: MessageItem | undefined): boolean {
  return item?.type === MessageItemType.IMAGE ||
    item?.type === MessageItemType.VIDEO ||
    item?.type === MessageItemType.FILE ||
    item?.type === MessageItemType.VOICE;
}

function bodyFromItemList(itemList?: MessageItem[]): string {
  if (!itemList?.length) {
    return "";
  }

  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) {
        return text;
      }

      if (ref.message_item && isMediaItem(ref.message_item)) {
        return text;
      }

      const parts: string[] = [];
      if (ref.title) {
        parts.push(ref.title);
      }
      if (ref.message_item) {
        const refBody = bodyFromItemList([ref.message_item]);
        if (refBody) {
          parts.push(refBody);
        }
      }

      return parts.length > 0 ? `[引用: ${parts.join(" | ")}]\n${text}` : text;
    }

    if (item.type === MessageItemType.VOICE && item.voice_item?.text != null) {
      return String(item.voice_item.text);
    }
  }

  return "";
}

export function extractWeixinText(message: Pick<WeixinMessage, "item_list">): string {
  return bodyFromItemList(message.item_list);
}
