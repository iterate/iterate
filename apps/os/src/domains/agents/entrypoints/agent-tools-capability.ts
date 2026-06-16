// AgentToolsCapability: the agent's own tools (chat.sendMessage, debug) as a
// dialable itx loopback (DIALABLE_LOOPBACKS).
//
// Why a forwarder instead of a durable-object ref: DO names are
// definer-controlled, so a raw ref could address another project's agent.
// Here the dial force-injects props.projectId at dial time and the DO
// name is derived from (projectId, agentPath) — a definer can only ever
// reach agents inside the context's own project.

import { WorkerEntrypoint } from "cloudflare:workers";
import { getAgentDurableObjectName } from "../agent-stream-subscriptions.ts";
import type { AgentDurableObject } from "../durable-objects/agent-durable-object.ts";
import type { PathCall } from "~/itx/itx.ts";
import { SELF_DESCRIPTION_METHOD } from "~/itx/path-proxy.ts";

export type AgentToolsCapabilityProps = {
  /** Injected by the dial — never definer-supplied. */
  projectId?: string;
  /** Which agent stream this tool cap is bound to. Definer-supplied. */
  agentPath: string;
  /** The tool namespace on the agent DO: "chat" or "debug". */
  tool: "chat" | "debug";
  capabilityPath?: string;
  context?: string;
};

export class AgentToolsCapability extends WorkerEntrypoint<Env, AgentToolsCapabilityProps> {
  async call(input: PathCall): Promise<unknown> {
    const props = this.ctx.props;
    // The provide-time self-description probe must fail fast WITHOUT touching
    // the agent DO: the probe runs while the agent's own wake hook may hold
    // the DO's input gate (providing these very capabilities), so dialing in
    // here would stall until the probe deadline — and for the debug tool it
    // would even execute a debug snapshot as a probe side effect.
    if (input.path.length === 1 && input.path[0] === SELF_DESCRIPTION_METHOD) {
      throw new Error("AgentToolsCapability does not self-describe.");
    }
    if (!props.projectId) {
      throw new Error("AgentToolsCapability needs dial-injected projectId props.");
    }
    const name = getAgentDurableObjectName({
      path: props.agentPath as never,
      projectId: props.projectId,
    });
    const agent = this.env.AGENT.getByName(name) as unknown as AgentDurableObject;
    return await agent.callAgentTool({
      args: input.args,
      callId: crypto.randomUUID(),
      path: input.path,
      tool: props.tool,
    });
  }
}
