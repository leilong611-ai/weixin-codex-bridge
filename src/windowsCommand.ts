export interface ProcessInvocation {
  args: string[];
  file: string;
}

export function buildCmdProcessInvocation(
  commandPath: string,
  args: string[],
  platform: NodeJS.Platform = process.platform
): ProcessInvocation {
  if (platform !== "win32") {
    return { file: commandPath, args };
  }

  return {
    file: "cmd.exe",
    args: ["/d", "/s", "/c", commandPath, ...args]
  };
}
