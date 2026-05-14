import { describe, expect, it } from "vitest";

import {
  buildDesktopModelPowerShellArgs,
  isAllowedDesktopModel,
  isDesktopModelCommandText,
  normalizeDesktopModelName,
  parseDesktopModelSwitch
} from "../src/desktopModel.js";

describe("desktop model helpers", () => {
  it("normalizes supported model aliases", () => {
    expect(normalizeDesktopModelName("5.4")).toBe("gpt-5.4");
    expect(normalizeDesktopModelName("gpt5.4")).toBe("gpt-5.4");
    expect(normalizeDesktopModelName("gpt-5.4-mini")).toBe("gpt-5.4-mini");
  });

  it("parses forgiving Weixin desktop model commands", () => {
    expect(parseDesktopModelSwitch("桌面模型5.4")).toBe("gpt-5.4");
    expect(parseDesktopModelSwitch("/桌面模型gpt-5.4切换")).toBe("gpt-5.4");
    expect(parseDesktopModelSwitch("gpt5.4")).toBe("gpt-5.4");
    expect(parseDesktopModelSwitch("5.4")).toBe("gpt-5.4");
    expect(parseDesktopModelSwitch("mini")).toBe("gpt-5.4-mini");
  });

  it("detects forgiving desktop model command text", () => {
    expect(isDesktopModelCommandText("桌面模型5.4")).toBe(true);
    expect(isDesktopModelCommandText("gpt5.4")).toBe(true);
    expect(isDesktopModelCommandText("这一版不成功")).toBe(false);
  });

  it("rejects unsupported desktop model names", () => {
    expect(isAllowedDesktopModel("totally-made-up-model")).toBe(false);
  });

  it("builds PowerShell args for the desktop model switcher", () => {
    expect(buildDesktopModelPowerShellArgs("C:\\scripts\\Set-CodexDesktopModel.ps1", "gpt-5.4")).toEqual([
      "-NoProfile",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\scripts\\Set-CodexDesktopModel.ps1",
      "-ModelName",
      "gpt-5.4"
    ]);
  });
});
