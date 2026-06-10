// AgentToolsCapability: the agent's own tools (chat.sendMessage, debug) as a
// dialable itx loopback (DIALABLE_LOOPBACKS).
//
// Why a forwarder instead of a durable-object ref: DO names are
// definer-controlled, so a raw ref could address another project's agent.
// Here the registry force-injects props.projectId at dial time and the DO
// name is derived from (projectId, agentPath) — a definer can only ever
// reach agents inside the context's own project.

import { WorkerEntrypoint } from "cloudflare:workers";
import { getAgentDurableObjectName } from "../agent-stream-subscriptions.ts";
import type { AgentDurableObject } from "../durable-objects/agent-durable-object.ts";
import type { PathCall } from "~/itx/protocol.ts";

export type AgentToolsCapabilityProps = {
  /** Injected by the registry at dial time — never definer-supplied. */
  projectId?: string;
  /** Which agent stream this tool cap is bound to. Definer-supplied. */
  agentPath: string;
  /** The tool namespace on the agent DO: "chat" or "debug". */
  tool: "chat" | "debug";
  cap?: string;
  context?: string;
};

export class AgentToolsCapability extends WorkerEntrypoint<Env, AgentToolsCapabilityProps> {
  async call(input: PathCall): Promise<unknown> {
    const props = (Reflect.get(this, "ctx") as ExecutionContext<AgentToolsCapabilityProps>).props;
    if (!props.projectId) {
      throw new Error("AgentToolsCapability needs registry-injected projectId props.");
    }
    const name = getAgentDurableObjectName({
      agentPath: props.agentPath as never,
      projectId: props.projectId,
    });
    const agent = this.env.AGENT.getByName(name) as unknown as AgentDurableObject;
    return await agent.executeCodemodeFunctionCall({
      args: input.args,
      codemodeSessionCapability: undefined as never,
      functionCallId: crypto.randomUUID(),
      functionPath: input.path,
      invocationKind: "rpc",
      path: [props.tool, ...input.path],
      providerPath: [props.tool],
    });
  }
}
