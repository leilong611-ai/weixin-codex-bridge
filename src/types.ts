export const MessageType = {
  USER: 1,
  BOT: 2
} as const;

export const MessageState = {
  FINISH: 2
} as const;

export const MessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5
} as const;

export interface TextItem {
  text?: string;
}

export interface VoiceItem {
  text?: string;
}

export interface ImageItem {
  media?: unknown;
}

export interface MessageItem {
  type?: number;
  text_item?: TextItem;
  voice_item?: VoiceItem;
  image_item?: ImageItem;
  ref_msg?: {
    title?: string;
    message_item?: MessageItem;
  };
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface SendMessageReq {
  msg?: WeixinMessage;
}

export interface WeixinAccount {
  accountId: string;
  baseUrl: string;
  token: string;
  userId?: string;
}

export interface BridgeRunResult {
  lastMessage: string;
  ok: boolean;
  runDirectory: string;
  stderr: string;
  stdout: string;
}

export interface CodexRunOptions {
  codexSessionId?: string;
  strictSession?: boolean;
}
