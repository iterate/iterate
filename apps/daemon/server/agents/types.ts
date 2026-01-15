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
  /** Tmux session name for terminal UI */
  tmuxSession: string;
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
  append(harnessSessionId: string, event: AgentEvent): Promise<void>;
}
