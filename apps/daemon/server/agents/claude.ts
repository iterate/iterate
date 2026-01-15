/**
 * Claude Agent Harness (Stub)
 *
 * Placeholder for future Claude Code integration.
 */

import type { AgentHarness, AgentEvent, CreateAgentParams, CreateAgentResult } from "./types.ts";

export const claudeHarness: AgentHarness = {
  type: "claude-code",

  async createAgent(_params: CreateAgentParams): Promise<CreateAgentResult> {
    throw new Error("Claude harness not implemented");
  },

  async append(_harnessSessionId: string, _event: AgentEvent): Promise<void> {
    throw new Error("Claude harness not implemented");
  },
};
