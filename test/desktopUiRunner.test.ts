import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BridgeConfig } from "../src/config.js";
import { DesktopUiRunner } from "../src/desktopUiRunner.js";

const tempRoots: string[] = [];

describe("DesktopUiRunner", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("does not retry Desktop UI input when the send is not recorded in a Codex session", async () => {
    const root = makeTempRoot();
    const codexHome = path.join(root, ".codex");
    const sessionsRoot = path.join(codexHome, "sessions", "2026", "05", "13");
    mkdirSync(sessionsRoot, { recursive: true });
    const sessionPath = path.join(sessionsRoot, "rollout-test.jsonl");
    writeFileSync(
      sessionPath,
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          cwd: root,
          id: "session-a",
          originator: "Codex Desktop"
        }
      })}\n`,
      "utf8"
    );

    const attemptPath = path.join(root, "attempt.txt");
    const fakeScriptPath = path.join(root, "fake-desktop-input.ps1");
    writeFileSync(fakeScriptPath, fakeDesktopInputScript(attemptPath, sessionPath), "utf8");

    await expect(new DesktopUiRunner({
      ...makeConfig(root),
      codexHome,
      desktopInputScriptPath: fakeScriptPath,
      desktopResponseTimeoutMs: 50
    }).runExactPrompt("hello from weixin", "weixin-session")).rejects.toThrow(
      "Timed out waiting for Codex Desktop to record the pasted prompt"
    );

    expect(Number.parseInt(readFileSync(attemptPath, "utf8"), 10)).toBe(1);
  }, 15_000);

  it("checks Desktop readiness before sending and stops before paste when readiness fails", async () => {
    const root = makeTempRoot();
    const codexHome = path.join(root, ".codex");
    const sessionsRoot = path.join(codexHome, "sessions", "2026", "05", "13");
    mkdirSync(sessionsRoot, { recursive: true });
    const sessionPath = path.join(sessionsRoot, "rollout-test.jsonl");
    writeFileSync(
      sessionPath,
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          cwd: root,
          id: "session-a",
          originator: "Codex Desktop"
        }
      })}\n`,
      "utf8"
    );

    const detectPath = path.join(root, "detect.txt");
    const sendPath = path.join(root, "send.txt");
    const fakeScriptPath = path.join(root, "fake-desktop-input.ps1");
    writeFileSync(fakeScriptPath, fakeFailingReadinessScript(detectPath, sendPath), "utf8");

    await expect(new DesktopUiRunner({
      ...makeConfig(root),
      codexHome,
      desktopInputScriptPath: fakeScriptPath,
      desktopResponseTimeoutMs: 50
    }).runExactPrompt("hello from weixin", "weixin-session")).rejects.toThrow(
      "Codex Desktop readiness check failed before paste"
    );

    expect(Number.parseInt(readFileSync(detectPath, "utf8"), 10)).toBe(1);
    expect(Number.parseInt(readFileSync(sendPath, "utf8"), 10)).toBe(0);
  }, 15_000);
});

function fakeDesktopInputScript(attemptPath: string, sessionPath: string): string {
  return `
param([string]$PromptPath, [switch]$DetectOnly)
$attemptPath = '${psLiteral(attemptPath)}'
$sessionPath = '${psLiteral(sessionPath)}'
if ($DetectOnly) {
    Write-Output "fake readiness ok"
    return
}
$attempt = 0
if (Test-Path -LiteralPath $attemptPath) {
    $attempt = [int](Get-Content -LiteralPath $attemptPath -Raw)
}
$attempt += 1
Set-Content -LiteralPath $attemptPath -Value ([string]$attempt) -Encoding UTF8
Write-Output "fake attempt $attempt"
`;
}

function fakeFailingReadinessScript(detectPath: string, sendPath: string): string {
  return `
param([string]$PromptPath, [switch]$DetectOnly)
$detectPath = '${psLiteral(detectPath)}'
$sendPath = '${psLiteral(sendPath)}'
if (-not (Test-Path -LiteralPath $detectPath)) {
    Set-Content -LiteralPath $detectPath -Value "0" -Encoding UTF8
}
if (-not (Test-Path -LiteralPath $sendPath)) {
    Set-Content -LiteralPath $sendPath -Value "0" -Encoding UTF8
}
if ($DetectOnly) {
    $detect = [int](Get-Content -LiteralPath $detectPath -Raw)
    Set-Content -LiteralPath $detectPath -Value ([string]($detect + 1)) -Encoding UTF8
    Write-Error "composer not ready"
    exit 7
}
$send = [int](Get-Content -LiteralPath $sendPath -Raw)
Set-Content -LiteralPath $sendPath -Value ([string]($send + 1)) -Encoding UTF8
Write-Output "unexpected send"
`;
}

function psLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "desktop-ui-runner-"));
  tempRoots.push(root);
  mkdirSync(path.join(root, "bridge"), { recursive: true });
  return root;
}

function makeConfig(root: string): BridgeConfig {
  return {
    autoDesktopSession: false,
    codexCmdPath: "codex.cmd",
    codexCwd: root,
    codexHome: path.join(root, ".codex"),
    codexModel: "gpt-5.4-mini",
    cliFallbackEnabled: false,
    consoleEnabled: false,
    consolePort: 18790,
    deliveryMode: "desktop-ui",
    desktopInputScriptPath: path.join(root, "Send-CodexDesktopInput.ps1"),
    desktopModelScriptPath: path.join(root, "Set-CodexDesktopModel.ps1"),
    desktopResponseTimeoutMs: 1000,
    logRoot: path.join(root, "bridge"),
    maxParallelRuns: 1,
    openclawConfigPath: path.join(root, "openclaw", "openclaw.json"),
    openclawStateRoot: path.join(root, "openclaw"),
    pollTimeoutMs: 1000,
    resumeAllSessions: true,
    resumeLast: true,
    skipBacklogOnStart: true,
    weixinChannelVersion: "2.1.1"
  };
}
