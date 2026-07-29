import { describe, expect, it } from "vitest";

import { buildCmdProcessInvocation } from "../src/windowsCommand.js";

describe("buildCmdProcessInvocation", () => {
  it("passes a .cmd path with spaces as a raw argv item", () => {
    const invocation = buildCmdProcessInvocation(
      "C:\\Users\\roy\\AppData\\Roaming\\npm\\codex.cmd",
      ["exec", "-C", "C:\\Users\\roy\\Documents\\New project 4", "-"]
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
});
