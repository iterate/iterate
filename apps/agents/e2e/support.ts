import { installAgents } from "../../../configs/with-agents/agents/install.ts";
import { openItx } from "../../os/e2e/support/client.ts";
import { agentRuntimeSource } from "../src/lib/agent-runtime-source.ts";

export async function openAgentItx(context: string) {
  const itx = openItx(context);
  await installAgents(itx, agentRuntimeSource);
  return itx;
}
