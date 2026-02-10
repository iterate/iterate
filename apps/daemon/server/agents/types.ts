/**
 * Agent Harness Types
 *
 * Defines the interface for agent harnesses that manage different agent types
 * (OpenCode, Claude Code, Pi). Each harness implements createAgent and append
 * methods specific to its agent type.
 */
import type { AgentType } from "../db/schema.ts";

export type AgentEventType = "user-message";

export interface AgentEvent {
  type: AgentEventType;
  content: string;
}

export interface CreateAgentParams {
  slug: string;
  workingDirectory: string;
  sessionName?: string;
}

export interface CreateAgentResult {
  /** Harness-specific session ID (e.g., OpenCode session ID) */
  harnessSessionId: string;
}

export interface StartCommandOptions {
  prompt?: string;
}

export interface AppendParams {
  workingDirectory: string;
  /** Called immediately when the message is received */
  acknowledge: () => Promise<void>;
  /** Called when the agent's turn ends (e.g., session becomes idle) */
  unacknowledge: () => Promise<void>;
  /** Called when the agent starts a tool call or changes status.
   *  Short strings (~30 chars) update the thread status indicator.
   *  Longer strings (>50 chars) are posted/updated as a thread message. */
  setStatus?: (
    status: string,
    context: { tool: string; input: Record<string, unknown> },
  ) => Promise<void>;
  /** Called ~1s after the session goes idle with an LLM-generated assessment
   *  of whether the agent actually resolved the user's request. */
  onIdle?: (summary: string) => Promise<void>;
}

export interface AgentHarness {
  type: AgentType;

  /**
   * Create an agent session and start the terminal UI.
   * Does not return until the agent is ready to receive messages.
   */
  createAgent(params: CreateAgentParams): Promise<CreateAgentResult>;

  /**
   * Send a message/event to an existing agent session.
   */
  append(
    harnessSessionId: string,
    event: AgentEvent,
    params: { workingDirectory: string },
  ): Promise<void>;

  /**
   * Get the command to start this agent in a terminal.
   * Returns an array of command parts (command + args).
   */
  getStartCommand(workingDirectory: string, options?: StartCommandOptions): string[];
}
