import { getAgentByName, type Agent as _Agent } from "agents";
import { env } from "../../env.ts";

export async function getAgentStub(params: {
  agentInstanceName: string;
  agentClassName: "IterateAgent" | "SlackAgent";
  reason: string;
}) {
  console.log(
    `[getAgentStub] Getting ${params.agentClassName} agent ${params.agentInstanceName}. Reason: ${params.reason}`,
  );
  if (params.agentClassName === "SlackAgent") {
    return await getAgentByName(env.SLACK_AGENT, params.agentInstanceName);
  } else if (params.agentClassName === "IterateAgent") {
    return await getAgentByName(env.ITERATE_AGENT, params.agentInstanceName);
  }
  throw new Error(`Unknown agent class name: ${params.agentClassName}`);
}
