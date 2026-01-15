/**
 * Pi Agent Harness (Stub)
 *
 * Placeholder for future Pi integration.
 */

import type { AgentHarness, AgentEvent, CreateAgentParams, CreateAgentResult } from "./types.ts";

export const piHarness: AgentHarness = {
  type: "pi",

  async createAgent(_params: CreateAgentParams): Promise<CreateAgentResult> {
    throw new Error("Pi harness not implemented");
  },

  async append(_harnessSessionId: string, _event: AgentEvent): Promise<void> {
    throw new Error("Pi harness not implemented");
  },
};
