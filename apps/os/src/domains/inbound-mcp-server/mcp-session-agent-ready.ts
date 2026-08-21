/**
 * Explicitly birth the session agent before ask() starts its reply timeout.
 * Creation is the CORE only: the project's config worker authors the
 * personality (kind "mcp" via itx.agents.get(path).getDefaultBirthEvents)
 * and finalizes the birth — the agent processor holds the first turn until it does,
 * with the platform's degraded-start deadline as the backstop, all well
 * inside ask()'s reply timeout.
 */
export async function ensureMcpSessionAgentReady(input: {
  agentPath: string;
  projectItx: {
    agents: {
      get(path: string): {
        create(): Promise<unknown>;
      };
    };
  };
}): Promise<void> {
  await input.projectItx.agents.get(input.agentPath).create();
}
