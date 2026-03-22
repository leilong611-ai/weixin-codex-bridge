import { spawn } from "node:child_process";

import { info } from "./log.mjs";
import { markdownToPlainText, sanitizeSessionName } from "./text.mjs";

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
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `Command failed (${code}): ${command} ${args.join(" ")}\n${stderr || stdout}`,
        ),
      );
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
  return markdownToPlainText(result.stdout.trim());
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
  const result = await runCommand(config.acpxCommand, [
    "--version",
  ], { cwd: config.workspace });
  return result.stdout.trim();
}
