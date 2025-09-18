import { getAgentByName, type Agent as _Agent } from "agents";
import type { CloudflareEnv } from "../../env.ts";

export async function getAgentStub(params: {
  env: CloudflareEnv;
  agentInstanceName: string;
  agentClassName: "IterateAgent"; //| "SlackAgent";
  reason: string;
}) {
  // TODO bring back slack agent
  // TODO bring back persistence of agent instances
  return await getAgentByName(params.env.ITERATE_AGENT, params.agentInstanceName);
}
