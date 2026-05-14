import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BridgeConfig } from "./config.js";
import { listDesktopSessions, type DesktopSession } from "./codexSession.js";
import { extractUserMessage, waitForTaskCompleteMessage } from "./codexTranscript.js";
import { detectCodexDesktopInputTarget, sendPromptFileToCodexDesktop } from "./desktopInput.js";
import { BridgeStateStore } from "./stateStore.js";
import type { BridgeRunResult, CodexRunOptions } from "./types.js";

interface SessionSnapshot {
  id: string;
  path: string;
  startOffset: number;
}

const MAX_PROMPT_RECORD_ATTEMPTS = 1;
const PROMPT_RECORD_ATTEMPT_TIMEOUT_MS = 15_000;

export class DesktopUiRunner {
  private readonly state: BridgeStateStore;

  constructor(private readonly config: BridgeConfig) {
    this.state = new BridgeStateStore(config);
  }

  async runExactPrompt(prompt: string, sessionKey: string, options: CodexRunOptions = {}): Promise<BridgeRunResult> {
    const runDirectory = await this.state.createRunDirectory(sessionKey);
    const promptPath = path.join(runDirectory, "prompt.txt");
    const stdoutPath = path.join(runDirectory, "stdout.log");
    const stderrPath = path.join(runDirectory, "stderr.log");
    const requestPath = path.join(runDirectory, "request.json");
    const lastMessagePath = path.join(runDirectory, "last-message.txt");
    const actualSessionPath = path.join(runDirectory, "actual-session.json");
    await writeFile(promptPath, prompt, "utf8");
    const actualSession = await this.sendPromptUntilRecorded({
      options,
      prompt,
      promptPath,
      requestPath,
      runDirectory,
      sessionKey,
      stderrPath,
      stdoutPath
    });
    await writeFile(actualSessionPath, `${JSON.stringify({
      id: actualSession.id,
      path: actualSession.path
    }, null, 2)}\n`, "utf8");

    const lastMessage = await waitForTaskCompleteMessage(
      actualSession.path,
      actualSession.startOffset,
      this.config.desktopResponseTimeoutMs
    );
    await writeFile(lastMessagePath, lastMessage, "utf8");

    return {
      lastMessage: lastMessage.trim(),
      ok: true,
      runDirectory,
      stderr: await readFile(stderrPath, "utf8"),
      stdout: await readFile(stdoutPath, "utf8")
    };
  }

  private async sendPromptUntilRecorded(params: {
    options: CodexRunOptions;
    prompt: string;
    promptPath: string;
    requestPath: string;
    runDirectory: string;
    sessionKey: string;
    stderrPath: string;
    stdoutPath: string;
  }): Promise<SessionSnapshot> {
    let stdout = "";
    let stderr = "";
    let lastRecordError: unknown;

    for (let attempt = 1; attempt <= MAX_PROMPT_RECORD_ATTEMPTS; attempt += 1) {
      const snapshots = await this.createSessionSnapshots(
        params.options.codexSessionId,
        Boolean(params.options.strictSession)
      );
      const targetSnapshot = params.options.codexSessionId
        ? snapshots.find((snapshot) => snapshot.id === params.options.codexSessionId)
        : undefined;
      await writeFile(params.requestPath, `${JSON.stringify({
        deliveryMode: "desktop-ui",
        promptPath: params.promptPath,
        sessionKey: params.sessionKey,
        targetSessionId: params.options.codexSessionId,
        strictSession: Boolean(params.options.strictSession),
        candidateCount: snapshots.length,
        promptRecordAttempt: attempt,
        promptRecordMaxAttempts: MAX_PROMPT_RECORD_ATTEMPTS,
        sessionPath: targetSnapshot?.path,
        codexSessionId: params.options.codexSessionId ?? this.config.codexSessionId,
        createdAt: new Date().toISOString()
      }, null, 2)}\n`, "utf8");

      const readinessResult = await detectCodexDesktopInputTarget(this.config.desktopInputScriptPath, params.promptPath);
      stdout += formatAttemptOutput(attempt, readinessResult.stdout);
      stderr += formatAttemptOutput(attempt, readinessResult.stderr);
      await writeFile(params.stdoutPath, stdout, "utf8");
      await writeFile(params.stderrPath, stderr, "utf8");
      if (readinessResult.exitCode !== 0) {
        const reason = (readinessResult.stderr || readinessResult.stdout).trim();
        throw new Error(reason
          ? `Codex Desktop readiness check failed before paste: ${reason}`
          : `Codex Desktop readiness check failed before paste with exit code ${readinessResult.exitCode ?? "unknown"}.`);
      }

      const inputResult = await sendPromptFileToCodexDesktop(this.config.desktopInputScriptPath, params.promptPath);
      stdout += formatAttemptOutput(attempt, inputResult.stdout);
      stderr += formatAttemptOutput(attempt, inputResult.stderr);
      await writeFile(params.stdoutPath, stdout, "utf8");
      await writeFile(params.stderrPath, stderr, "utf8");

      if (inputResult.exitCode !== 0) {
        throw new Error(inputResult.stderr.trim() || `Codex Desktop input script failed with exit code ${inputResult.exitCode ?? "unknown"}.`);
      }

      try {
        return await this.waitForPromptInSessions(
          snapshots,
          params.prompt,
          Math.min(this.config.desktopResponseTimeoutMs, PROMPT_RECORD_ATTEMPT_TIMEOUT_MS)
        );
      } catch (error) {
        lastRecordError = error;
        if (attempt >= MAX_PROMPT_RECORD_ATTEMPTS) {
          break;
        }

        await sleep(Math.min(5_000, attempt * 1_000));
      }
    }

    throw lastRecordError instanceof Error
      ? lastRecordError
      : new Error("Timed out waiting for Codex Desktop to record the pasted prompt in a monitored session.");
  }

  private async createSessionSnapshots(selectedSessionId: string | undefined, strictSession: boolean): Promise<SessionSnapshot[]> {
    const sessions = listDesktopSessions({ codexHome: this.config.codexHome });
    const filtered = strictSession && selectedSessionId
      ? sessions.filter((session) => session.id === selectedSessionId)
      : sessions;

    if (filtered.length === 0) {
      throw new Error(selectedSessionId
        ? `Could not find selected Codex Desktop session file for ${selectedSessionId}`
        : "Could not find any Codex Desktop session files.");
    }

    return Promise.all(filtered.map(async (session) => ({
      id: session.id,
      path: session.path,
      startOffset: (await stat(session.path)).size
    })));
  }

  private async waitForPromptInSessions(
    snapshots: SessionSnapshot[],
    prompt: string,
    timeoutMs: number
  ): Promise<SessionSnapshot> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      for (const snapshot of snapshots) {
        const currentSize = (await stat(snapshot.path)).size;
        if (currentSize <= snapshot.startOffset) {
          continue;
        }

        const content = await readFile(snapshot.path);
        const appended = content.subarray(snapshot.startOffset).toString("utf8");
        if (extractUserMessage(appended, prompt)) {
          return snapshot;
        }
      }

      await sleep(250);
    }

    throw new Error("Timed out waiting for Codex Desktop to record the pasted prompt in a monitored session.");
  }
}

function formatAttemptOutput(attempt: number, output: string): string {
  const text = output.trimEnd();
  return text
    ? `Attempt ${attempt}:\n${text}\n`
    : "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
