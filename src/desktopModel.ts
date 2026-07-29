import { spawn } from "node:child_process";

export const allowedDesktopModels = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2"
] as const;

const modelAliases = new Map<string, string>([
  ["5.5", "gpt-5.5"],
  ["5.4", "gpt-5.4"],
  ["5.4-mini", "gpt-5.4-mini"],
  ["mini", "gpt-5.4-mini"],
  ["codex", "gpt-5.3-codex"],
  ["spark", "gpt-5.3-codex-spark"],
  ["5.2", "gpt-5.2"]
]);

export interface DesktopModelSwitchResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

export function normalizeDesktopModelName(input: string): string | undefined {
  const clean = input.trim().toLowerCase().replace(/\s+/g, "").replace(/^gpt(?=\d)/, "gpt-");
  if (!clean) {
    return undefined;
  }

  return modelAliases.get(clean) ?? clean;
}

export function parseDesktopModelSwitch(text: string): string | undefined {
  const clean = normalizeDesktopCommandText(text);
  if (!clean) {
    return undefined;
  }

  const commandLike = clean.includes("桌面模型") ||
    clean.startsWith("模型") ||
    clean.includes("切换") ||
    clean.includes("换成") ||
    clean.includes("改成") ||
    clean.startsWith("换") ||
    isExactModelAlias(clean);
  if (!commandLike) {
    return undefined;
  }

  const patterns: Array<[RegExp, string]> = [
    [/gpt-?5\.3-?codex-?spark/, "gpt-5.3-codex-spark"],
    [/gpt-?5\.3-?codex/, "gpt-5.3-codex"],
    [/gpt-?5\.4-?mini/, "gpt-5.4-mini"],
    [/5\.4-?mini/, "gpt-5.4-mini"],
    [/gpt-?5\.5/, "gpt-5.5"],
    [/gpt-?5\.4/, "gpt-5.4"],
    [/gpt-?5\.2/, "gpt-5.2"],
    [/5\.5/, "gpt-5.5"],
    [/5\.4/, "gpt-5.4"],
    [/5\.2/, "gpt-5.2"],
    [/spark/, "gpt-5.3-codex-spark"],
    [/codex/, "gpt-5.3-codex"],
    [/mini/, "gpt-5.4-mini"]
  ];

  for (const [pattern, model] of patterns) {
    if (pattern.test(clean)) {
      return model;
    }
  }

  return undefined;
}

export function isDesktopModelCommandText(text: string): boolean {
  const clean = normalizeDesktopCommandText(text);
  return clean === "桌面模型" ||
    clean === "desktopmodel" ||
    Boolean(parseDesktopModelSwitch(text));
}

export function isAllowedDesktopModel(input: string): boolean {
  const normalized = normalizeDesktopModelName(input);
  return Boolean(normalized && allowedDesktopModels.includes(normalized as typeof allowedDesktopModels[number]));
}

export function buildDesktopModelPowerShellArgs(scriptPath: string, modelName: string): string[] {
  return [
    "-NoProfile",
    "-STA",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-ModelName",
    modelName
  ];
}

export function switchCodexDesktopModel(scriptPath: string, modelName: string): Promise<DesktopModelSwitchResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", buildDesktopModelPowerShellArgs(scriptPath, modelName), {
      windowsHide: true
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode
      });
    });
  });
}

function isExactModelAlias(text: string): boolean {
  return Boolean(normalizeDesktopModelName(text) && isAllowedDesktopModel(text));
}

function normalizeDesktopCommandText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/[：:，,。.\s]/g, (match) => match === "." ? "." : "")
    .replace(/到|为|成|一下|切|换/g, (match) => match === "换" ? "换" : "")
    .replace(/^gpt(?=\d)/, "gpt-");
}
