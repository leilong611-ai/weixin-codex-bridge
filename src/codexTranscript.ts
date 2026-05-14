import { readFile, stat } from "node:fs/promises";

function stripSubmitNewline(message: string): string {
  return message.replace(/(?:\r?\n)+$/u, "");
}

export function extractTaskCompleteMessage(jsonlText: string): string | undefined {
  let lastMessage: string | undefined;
  let lastAgentMessage: string | undefined;

  for (const line of jsonlText.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as {
        type?: string;
        payload?: {
          type?: string;
          message?: unknown;
          last_agent_message?: unknown;
        };
      };
      if (
        parsed.type === "event_msg" &&
        parsed.payload?.type === "agent_message" &&
        typeof parsed.payload.message === "string" &&
        parsed.payload.message.trim()
      ) {
        lastAgentMessage = parsed.payload.message;
      }

      if (
        parsed.type === "event_msg" &&
        parsed.payload?.type === "task_complete" &&
        typeof parsed.payload.last_agent_message === "string"
      ) {
        lastMessage = parsed.payload.last_agent_message.trim()
          ? parsed.payload.last_agent_message
          : lastAgentMessage;
      }
    } catch {
      // Session logs can contain partial lines while Codex is still writing.
    }
  }

  return lastMessage;
}

export function extractUserMessage(jsonlText: string, expectedMessage: string): string | undefined {
  const expected = stripSubmitNewline(expectedMessage);

  for (const line of jsonlText.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as {
        type?: string;
        payload?: {
          type?: string;
          message?: unknown;
          role?: unknown;
          content?: unknown;
        };
      };
      if (
        parsed.type === "event_msg" &&
        parsed.payload?.type === "user_message" &&
        typeof parsed.payload.message === "string" &&
        stripSubmitNewline(parsed.payload.message) === expected
      ) {
        return parsed.payload.message;
      }

      if (
        parsed.type === "response_item" &&
        parsed.payload?.type === "message" &&
        parsed.payload.role === "user" &&
        Array.isArray(parsed.payload.content)
      ) {
        const text = parsed.payload.content
          .map((item) => isInputText(item) ? item.text : "")
          .join("");
        if (text && stripSubmitNewline(text) === expected) {
          return text;
        }
      }
    } catch {
      // Session logs can contain partial lines while Codex is still writing.
    }
  }

  return undefined;
}

function isInputText(item: unknown): item is { type: string; text: string } {
  return Boolean(
    item &&
      typeof item === "object" &&
      "type" in item &&
      "text" in item &&
      (item as { type?: unknown }).type === "input_text" &&
      typeof (item as { text?: unknown }).text === "string"
  );
}

export async function waitForTaskCompleteMessage(
  sessionPath: string,
  startOffset: number,
  timeoutMs: number
): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const currentSize = (await stat(sessionPath)).size;
    if (currentSize > startOffset) {
      const appended = await readAppendedUtf8(sessionPath, startOffset);
      const message = extractTaskCompleteMessage(appended);
      if (message) {
        return message;
      }
    }

    await sleep(1_000);
  }

  throw new Error(`Timed out waiting for Codex Desktop task completion in ${sessionPath}`);
}

export async function waitForUserMessage(
  sessionPath: string,
  startOffset: number,
  expectedMessage: string,
  timeoutMs: number
): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const currentSize = (await stat(sessionPath)).size;
    if (currentSize > startOffset) {
      const appended = await readAppendedUtf8(sessionPath, startOffset);
      const message = extractUserMessage(appended, expectedMessage);
      if (message) {
        return message;
      }
    }

    await sleep(250);
  }

  throw new Error(`Timed out waiting for Codex Desktop to record the pasted prompt in ${sessionPath}`);
}

async function readAppendedUtf8(sessionPath: string, startOffset: number): Promise<string> {
  const content = await readFile(sessionPath);
  return content.subarray(startOffset).toString("utf8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
