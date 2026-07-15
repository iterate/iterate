import { MCP_AGENT_SYSTEM_PROMPT } from "../agents/agent-defaults.ts";

/** Explicitly birth the session agent before ask() starts its reply timeout. */
export async function ensureMcpSessionAgentReady(input: {
  agentPath: string;
  projectItx: {
    agents: {
      get(path: string): {
        create(config: { systemPrompt: string }): Promise<void>;
      };
    };
  };
}): Promise<void> {
  await input.projectItx.agents.get(input.agentPath).create({
    systemPrompt: MCP_AGENT_SYSTEM_PROMPT,
  });
}
