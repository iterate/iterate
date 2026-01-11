import type { AgentType } from "@/db/schema.ts";

export interface AgentHarness {
  type: AgentType;
  getStartCommand(workingDir: string, options?: { prompt?: string }): string[];
}

const claudeCodeHarness: AgentHarness = {
  type: "claude-code",
  getStartCommand(_workingDir, options) {
    const cmd = ["claude"];
    if (options?.prompt) {
      cmd.push(options.prompt);
    }
    return cmd;
  },
};

const opencodeHarness: AgentHarness = {
  type: "opencode",
  getStartCommand(_workingDir, options) {
    const cmd = ["opencode"];
    if (options?.prompt) {
      cmd.push("--prompt", options.prompt);
    }
    return cmd;
  },
};

const piHarness: AgentHarness = {
  type: "pi",
  getStartCommand(_workingDir, options) {
    const cmd = ["pi"];
    if (options?.prompt) {
      cmd.push(options.prompt);
    }
    return cmd;
  },
};

const harnesses: Record<AgentType, AgentHarness> = {
  "claude-code": claudeCodeHarness,
  opencode: opencodeHarness,
  pi: piHarness,
};

export function getHarness(type: AgentType): AgentHarness {
  return harnesses[type];
}

export function getCommandString(command: string[]): string {
  return command.map((arg) => (arg.includes(" ") ? `"${arg}"` : arg)).join(" ");
}
