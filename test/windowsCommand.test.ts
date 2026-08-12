import { describe, expect, it } from "vitest";

import { buildCmdProcessInvocation } from "../src/windowsCommand.js";

describe("buildCmdProcessInvocation", () => {
  it("passes a .cmd path with spaces as a raw argv item", () => {
    const invocation = buildCmdProcessInvocation(
      "C:\\Users\\roy\\AppData\\Roaming\\npm\\codex.cmd",
      ["exec", "-C", "C:\\Users\\roy\\Documents\\New project 4", "-"],
      "win32"
    );

    expect(invocation.file).toBe("cmd.exe");
    expect(invocation.args).toEqual([
      "/d",
      "/s",
      "/c",
      "C:\\Users\\roy\\AppData\\Roaming\\npm\\codex.cmd",
      "exec",
      "-C",
      "C:\\Users\\roy\\Documents\\New project 4",
      "-"
    ]);
    expect(invocation.args.join(" ")).not.toContain('\\"');
  });

  it("executes the Codex binary directly outside Windows", () => {
    const invocation = buildCmdProcessInvocation(
      "codex",
      ["exec", "-C", "/var/tmp/project", "-"],
      "linux"
    );

    expect(invocation).toEqual({
      file: "codex",
      args: ["exec", "-C", "/var/tmp/project", "-"]
    });
  });
});
