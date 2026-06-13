import { WorkerEntrypoint } from "cloudflare:workers";
import { getInitializedDoStub } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { StreamPath } from "@iterate-com/shared/streams/types";
import type { Event } from "@iterate-com/shared/streams/types";
import { getAgentDurableObjectName } from "~/domains/agents/durable-objects/agent-durable-object.ts";
import type { AgentDurableObject } from "~/domains/agents/durable-objects/agent-durable-object.ts";
import { replayPathCall } from "~/itx/path-proxy.ts";
import type { PathCall } from "~/itx/itx.ts";

type AgentsCapabilityEnv = {
  AGENT?: DurableObjectNamespace<AgentDurableObject>;
};

type AgentsCapabilityProps = {
  projectId?: string;
};

type AgentRpcStub = {
  sendMessage(input: { channel?: string; message: string }): Promise<{ event: Event }>;
};

/**
 * The PROJECT-scoped agents surface reachable over itx (`itx.agents.sendMessage`).
 *
 * The one method is {@link sendMessage}: it routes through the agent
 * Durable Object's own `sendMessage`, which runs `ensureStartedAndCaughtUp()`
 * — so it FORCE-WAKES a cold or never-started agent (creating the DO with
 * `allowCreate: true`) before appending the user message. A raw stream append
 * does NOT do this: it lands an event on a stream nobody is subscribed to yet,
 * because a never-started agent has no live subscriptions. Listing agents and
 * reading/writing presets go directly through `itx.streams` on the /agents tree.
 *
 * This is a DIFFERENT context from the per-agent `agents` capability the agent
 * DO provides on its OWN context (agent-durable-object.ts) — that one lives on
 * an agent's chain; this one is a project-level default. Different contexts
 * have independent capability maps, so the project default never shadows (and
 * is never shadowed by) an agent's own.
 */
export class AgentsCapability extends WorkerEntrypoint<AgentsCapabilityEnv, AgentsCapabilityProps> {
  /** The itx kernel's one calling convention; replay walks this entrypoint's own members. */
  call(input: PathCall): Promise<unknown> {
    return replayPathCall(this, input);
  }

  /**
   * Force-wake the agent (cold/legacy included) and append the user message
   * through its DO `sendMessage` — the path that runs ensureStartedAndCaughtUp.
   */
  async sendMessage(input: { agentPath: string; message: string; channel?: string }) {
    const agent = await this.getAgent(input.agentPath);
    return await agent.sendMessage({ channel: input.channel, message: input.message });
  }

  private async getAgent(agentPathInput: string): Promise<AgentRpcStub> {
    if (!this.env.AGENT) {
      throw new Error("AGENT Durable Object namespace is not configured.");
    }
    return (await getInitializedDoStub({
      allowCreate: true,
      namespace: this.env.AGENT,
      name: getAgentDurableObjectName({
        agentPath: StreamPath.parse(agentPathInput),
        projectId: this.projectId(),
      }),
    })) as unknown as AgentRpcStub;
  }

  private projectId(): string {
    const projectId = this.ctx.props.projectId;
    if (!projectId) throw new Error("AgentsCapability requires ctx.props.projectId.");
    return projectId;
  }
}
