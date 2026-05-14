import { spawn } from "node:child_process";

import { info } from "./log.mjs";
import { markdownToPlainText, sanitizeSessionName } from "./text.mjs";

function stripAnsi(text) {
  return (text ?? "").replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function normalizeOutput(text) {
  return markdownToPlainText(stripAnsi(text).trim());
}

function formatStreamDetails(stdout, stderr) {
  const parts = [];
  const cleanStderr = stripAnsi(stderr).trim();
  const cleanStdout = stripAnsi(stdout).trim();
  if (cleanStderr) {
    parts.push(cleanStderr);
  }
  if (cleanStdout && cleanStdout !== cleanStderr) {
    parts.push(cleanStdout);
  }
  return parts.join("\n\n");
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
        return;
      }
      const details = formatStreamDetails(stdout, stderr);
      const err = new Error(
        `Command failed (${code}): ${command} ${args.join(" ")}${details ? `\n${details}` : ""}`,
      );
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      err.command = command;
      err.args = args;
      reject(err);
    });
  });
}

function buildBaseArgs(config) {
  return [
    "--cwd",
    config.workspace,
    "--format",
    "quiet",
    "--timeout",
    String(config.codexTimeoutSeconds),
  ];
}

export function buildSessionName(config, weixinUserId) {
  return sanitizeSessionName(`${config.sessionPrefix}-${weixinUserId}`);
}

export async function ensureSession(config, weixinUserId) {
  const sessionName = buildSessionName(config, weixinUserId);
  await runCommand(config.acpxCommand, [
    ...buildBaseArgs(config),
    "codex",
    "sessions",
    "ensure",
    "--name",
    sessionName,
  ]);
  return sessionName;
}

export async function promptCodex(config, weixinUserId, prompt) {
  const sessionName = await ensureSession(config, weixinUserId);
  info(`Prompting Codex session ${sessionName}`);
  const result = await runCommand(config.acpxCommand, [
    ...buildBaseArgs(config),
    "codex",
    "prompt",
    "-s",
    sessionName,
    prompt,
  ]);
  const reply = normalizeOutput(result.stdout);
  const diagnostics = stripAnsi(result.stderr).trim();
  if (!diagnostics) {
    return reply;
  }
  const extraOutput = `Codex 额外输出：\n${diagnostics.slice(0, 2000)}`;
  return [reply, extraOutput].filter(Boolean).join("\n\n");
}

export async function resetSession(config, weixinUserId) {
  const sessionName = buildSessionName(config, weixinUserId);
  await runCommand(config.acpxCommand, [
    ...buildBaseArgs(config),
    "codex",
    "sessions",
    "close",
    sessionName,
  ]).catch(() => {});
  await ensureSession(config, weixinUserId);
  return sessionName;
}

export async function doctorCodex(config) {
  const result = await runCommand(config.acpxCommand, ["--version"], { cwd: config.workspace });
  return result.stdout.trim();
}
