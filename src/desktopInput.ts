import { spawn } from "node:child_process";

export interface DesktopInputPowerShellOptions {
  detectOnly?: boolean;
}

export interface DesktopInputScriptResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

export function buildDesktopInputPowerShellArgs(
  scriptPath: string,
  promptPath: string,
  options: DesktopInputPowerShellOptions = {}
): string[] {
  const args = [
    "-NoProfile",
    "-STA",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-PromptPath",
    promptPath
  ];

  if (options.detectOnly) {
    args.push("-DetectOnly");
  }

  return args;
}

export function sendPromptFileToCodexDesktop(scriptPath: string, promptPath: string): Promise<DesktopInputScriptResult> {
  return runDesktopInputScript(scriptPath, promptPath);
}

export function detectCodexDesktopInputTarget(scriptPath: string, promptPath: string): Promise<DesktopInputScriptResult> {
  return runDesktopInputScript(scriptPath, promptPath, { detectOnly: true });
}

function runDesktopInputScript(
  scriptPath: string,
  promptPath: string,
  options: DesktopInputPowerShellOptions = {}
): Promise<DesktopInputScriptResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", buildDesktopInputPowerShellArgs(scriptPath, promptPath, options), {
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
