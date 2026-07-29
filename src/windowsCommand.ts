export interface ProcessInvocation {
  args: string[];
  file: string;
}

export function buildCmdProcessInvocation(commandPath: string, args: string[]): ProcessInvocation {
  return {
    file: "cmd.exe",
    args: ["/d", "/s", "/c", commandPath, ...args]
  };
}
