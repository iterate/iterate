/**
 * Claude Code Agent Harness
 *
 * CLI-based agent. The CLI is spawned directly in the terminal when the user views the agent.
 * Does not use tmux - node-pty spawns `claude` directly.
 */
import { randomUUID } from "node:crypto";
import type { AgentHarness, AgentEvent, CreateAgentParams, CreateAgentResult } from "./types.ts";

export const claudeHarness: AgentHarness = {
  type: "claude-code",

  async createAgent(_params: CreateAgentParams): Promise<CreateAgentResult> {
    // Generate a session ID for tracking. The actual CLI is spawned when user opens terminal.
    const harnessSessionId = `claude-${randomUUID().slice(0, 8)}`;

    return {
      harnessSessionId,
      // No tmux session - CLI spawned directly via node-pty
    };
  },

  async append(_harnessSessionId: string, _event: AgentEvent): Promise<void> {
    // Claude Code doesn't have a server API for sending messages programmatically.
    // Users interact via the terminal UI.
    throw new Error(
      "Claude Code agents don't support programmatic messages. Use the terminal UI to interact.",
    );
  },
};
