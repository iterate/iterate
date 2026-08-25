import type { StreamEvent } from "iterate/processors";
import {
  agentSystemPromptContextEvents,
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
        create(): Promise<unknown>;
        append(...events: AgentEventInput[]): Promise<StreamEvent[]>;
      };
    };
  };
}): Promise<void> {
  const agent = input.projectItx.agents.get(input.agentPath);
  await agent.create();
  // One keyed event per section, all in a SINGLE append call: the batch
  // commits atomically, so no render can see a half-written prompt.
  await agent.append(
    ...agentSystemPromptContextEvents({
      content: MCP_AGENT_SYSTEM_PROMPT,
      // ":v2:" — the payload shape changed (kind/actor) while an unchanged
      // prompt keeps its content-hash revision; a replay over a session
      // born under the older shape must supersede, not trip
      // same-key-different-body.
      idempotencyKeyBase: `agent/mcp-system-prompt:v2:v${MCP_AGENT_SYSTEM_PROMPT_REVISION}`,
    }),
  );
}
