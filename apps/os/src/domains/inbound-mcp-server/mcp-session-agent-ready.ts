import type { StreamEvent } from "iterate/processors";
import {
  agentSystemPromptContextEvent,
  MCP_AGENT_SYSTEM_PROMPT,
  MCP_AGENT_SYSTEM_PROMPT_REVISION,
} from "../agents/agent-defaults.ts";
import type { AgentEventInput } from "../agents/agent-processor-contract.ts";

/** Explicitly birth the session agent before ask() starts its reply timeout. */
export async function ensureMcpSessionAgentReady(input: {
  agentPath: string;
  projectItx: {
    agents: {
      get(path: string): {
        create(): Promise<void>;
        append(...events: AgentEventInput[]): Promise<StreamEvent[]>;
      };
    };
  };
}): Promise<void> {
  const agent = input.projectItx.agents.get(input.agentPath);
  await agent.create();
  await agent.append(
    agentSystemPromptContextEvent({
      content: MCP_AGENT_SYSTEM_PROMPT,
      idempotencyKey: `agent/mcp-system-prompt:v${MCP_AGENT_SYSTEM_PROMPT_REVISION}`,
    }),
  );
}
