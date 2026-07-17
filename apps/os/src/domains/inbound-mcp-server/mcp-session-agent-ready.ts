import {
  agentSystemPromptContextEvent,
  MCP_AGENT_SYSTEM_PROMPT,
} from "../agents/agent-defaults.ts";

/** Explicitly birth the session agent before ask() starts its reply timeout. */
export async function ensureMcpSessionAgentReady(input: {
  agentPath: string;
  projectItx: {
    agents: {
      get(path: string): {
        create(): Promise<void>;
        processor: {
          snapshot(): Promise<{ state: { birthCertificate: unknown | null } }>;
        };
        stream: {
          append(...events: unknown[]): Promise<unknown>;
        };
      };
    };
  };
}): Promise<void> {
  const agent = input.projectItx.agents.get(input.agentPath);
  const snapshot = await agent.processor.snapshot();
  if (snapshot.state.birthCertificate === null) {
    await agent.create();
  }
  await agent.stream.append(
    agentSystemPromptContextEvent({
      content: MCP_AGENT_SYSTEM_PROMPT,
      idempotencyKey: "agent/mcp-system-prompt",
    }),
  );
}
