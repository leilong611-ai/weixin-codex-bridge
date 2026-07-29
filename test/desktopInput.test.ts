import { describe, expect, it } from "vitest";

import { buildDesktopInputPowerShellArgs } from "../src/desktopInput.js";

describe("buildDesktopInputPowerShellArgs", () => {
  it("passes the prompt path as an argv item instead of embedding text in the command line", () => {
    const args = buildDesktopInputPowerShellArgs(
      "C:\\Users\\roy\\Documents\\New project 4\\scripts\\Send-CodexDesktopInput.ps1",
      "D:\\OpenClawWorkspace\\tmp\\codex-weixin-bridge\\runs\\prompt.txt"
    );

    expect(args).toEqual([
      "-NoProfile",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\Users\\roy\\Documents\\New project 4\\scripts\\Send-CodexDesktopInput.ps1",
      "-PromptPath",
      "D:\\OpenClawWorkspace\\tmp\\codex-weixin-bridge\\runs\\prompt.txt"
    ]);
  });

  it("can run the desktop input script in detect-only mode without sending text", () => {
    const args = buildDesktopInputPowerShellArgs(
      "C:\\Users\\roy\\Documents\\New project 4\\scripts\\Send-CodexDesktopInput.ps1",
      "D:\\OpenClawWorkspace\\tmp\\codex-weixin-bridge\\runs\\prompt.txt",
      { detectOnly: true }
    );

    expect(args).toEqual([
      "-NoProfile",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\Users\\roy\\Documents\\New project 4\\scripts\\Send-CodexDesktopInput.ps1",
      "-PromptPath",
      "D:\\OpenClawWorkspace\\tmp\\codex-weixin-bridge\\runs\\prompt.txt",
      "-DetectOnly"
    ]);
  });
});
