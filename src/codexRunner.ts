import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BridgeConfig } from "./config.js";
import type { BridgeRunResult, CodexRunOptions } from "./types.js";
import { BridgeStateStore } from "./stateStore.js";
import { buildCmdProcessInvocation } from "./windowsCommand.js";

export class CodexRunner {
  private readonly state: BridgeStateStore;

  constructor(private readonly config: BridgeConfig) {
    this.state = new BridgeStateStore(config);
  }

  async runExactPrompt(prompt: string, sessionKey: string, options: CodexRunOptions = {}): Promise<BridgeRunResult> {
    const runDirectory = await this.state.createRunDirectory(sessionKey);
    const lastMessagePath = path.join(runDirectory, "last-message.txt");
    const promptPath = path.join(runDirectory, "prompt.txt");
    const stdoutPath = path.join(runDirectory, "stdout.jsonl");
    const stderrPath = path.join(runDirectory, "stderr.log");
    const requestPath = path.join(runDirectory, "request.json");
    const args = this.buildArgs(prompt, lastMessagePath, options.codexSessionId);

    await writeFile(promptPath, prompt, "utf8");
    await writeFile(requestPath, `${JSON.stringify({
      args,
      codexCmdPath: this.config.codexCmdPath,
      codexCwd: this.config.codexCwd,
      createdAt: new Date().toISOString(),
      promptPath,
      sessionKey
    }, null, 2)}\n`, "utf8");

    const result = await this.spawnCodex(args, prompt, stdoutPath, stderrPath);
    const lastMessage = await readOptional(lastMessagePath);
    const stdout = await readOptional(stdoutPath);
    const stderr = await readOptional(stderrPath);

    return {
      lastMessage: lastMessage.trim(),
      ok: result.exitCode === 0,
      runDirectory,
      stderr,
      stdout
    };
  }

  private buildArgs(prompt: string, lastMessagePath: string, selectedSessionId?: string): string[] {
    const args = ["exec", "-C", this.config.codexCwd];
    const sessionId = selectedSessionId ?? this.config.codexSessionId;

    if (this.config.resumeLast || sessionId) {
      args.push("resume");
      if (sessionId) {
        args.push(sessionId);
      } else {
        args.push("--last");
      }
      if (this.config.resumeAllSessions) {
        args.push("--all");
      }
    }

    args.push("--json", "--full-auto", "--skip-git-repo-check", "-o", lastMessagePath);

    if (this.config.codexModel) {
      args.push("-m", this.config.codexModel);
    }

    args.push("-");
    return args;
  }

  private spawnCodex(args: string[], prompt: string, stdoutPath: string, stderrPath: string): Promise<{ exitCode: number | null }> {
    return new Promise((resolve, reject) => {
      const invocation = buildCmdProcessInvocation(this.config.codexCmdPath, args);
      const child = spawn(invocation.file, invocation.args, {
        cwd: this.config.codexCwd,
        windowsHide: true
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      child.on("error", reject);
      child.stdin.end(prompt);
      child.on("close", async (exitCode) => {
        await Promise.all([
          writeFile(stdoutPath, Buffer.concat(stdoutChunks)),
          writeFile(stderrPath, Buffer.concat(stderrChunks))
        ]);
        resolve({ exitCode });
      });
    });
  }
}

async function readOptional(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}
