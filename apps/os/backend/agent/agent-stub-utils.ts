import { getAgentByName } from "agents";
import { env } from "../../env.ts";
import type { IterateAgent, SlackAgent } from "../worker.ts";
import * as schema from "../db/schema.ts";

type AgentClassName = "IterateAgent" | "SlackAgent";

function getNamespaceForClass(className: "SlackAgent"): DurableObjectNamespace<SlackAgent>;
function getNamespaceForClass(className: "IterateAgent"): DurableObjectNamespace<IterateAgent>;
function getNamespaceForClass(className: AgentClassName) {
  switch (className) {
    case "SlackAgent":
      return env.SLACK_AGENT;
    case "IterateAgent":
      return env.ITERATE_AGENT;
  }
}
export async function getAgentStub({
  durableObjectName,
  durableObjectClassName,
  agentRecord,
}: {
  durableObjectName: string;
  durableObjectClassName: AgentClassName;
  agentRecord: typeof schema.agentInstance.$inferSelect;
}) {
  const stub = await (durableObjectClassName === "SlackAgent"
    ? getAgentByName(getNamespaceForClass("SlackAgent"), durableObjectName)
    : getAgentByName(getNamespaceForClass("IterateAgent"), durableObjectName));
  await stub.setDatabaseRecord(agentRecord);
  return stub;
}
