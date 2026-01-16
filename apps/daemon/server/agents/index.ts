/**
 * Agent Harness Factory
 *
 * Exports all harnesses and provides a factory function to get
 * the appropriate harness for an agent type.
 */

import type { AgentType } from "../db/schema.ts";
import type { AgentHarness } from "./types.ts";
import { opencodeHarness } from "./opencode.ts";
import { claudeHarness } from "./claude.ts";
import { piHarness } from "./pi.ts";

export { opencodeHarness } from "./opencode.ts";
export { claudeHarness } from "./claude.ts";
export { piHarness } from "./pi.ts";
export type {
  AgentHarness,
  AgentEvent,
  CreateAgentParams,
  CreateAgentResult,
  StartCommandOptions,
} from "./types.ts";

/**
 * Convert a command array to a shell command string.
 * Properly escapes arguments that contain spaces or special characters.
 */
export function getCommandString(command: string[]): string {
  return command
    .map((arg) => {
      // If arg contains spaces or shell special characters, wrap in single quotes
      if (/[\s"'$`\\!*?[\]{}()<>|&;]/.test(arg)) {
        // Escape single quotes within the arg
        return `'${arg.replace(/'/g, "'\\''")}'`;
      }
      return arg;
    })
    .join(" ");
}

const harnesses: Record<AgentType, AgentHarness> = {
  opencode: opencodeHarness,
  "claude-code": claudeHarness,
  pi: piHarness,
};

/**
 * Get the harness for a given agent type.
 */
export function getHarness(agentType: AgentType): AgentHarness {
  const harness = harnesses[agentType];
  if (!harness) {
    throw new Error(`Unknown agent type: ${agentType}`);
  }
  return harness;
}
