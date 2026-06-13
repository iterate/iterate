import { WorkerEntrypoint } from "cloudflare:workers";
import { getInitializedDoStub } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { StreamPath } from "@iterate-com/shared/streams/types";
import type { Event } from "@iterate-com/shared/streams/types";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "~/domains/streams/stream-runtime.ts";
import {
  configuredAgentSetupEvents,
  normalizeAgentPresetBasePath,
  presetConfiguredEvent,
  readAgentPathPrefixPresets,
  type AgentLlmProvider,
} from "~/domains/agents/agent-presets.ts";
import {
  AGENTS_STREAM_PATH,
  getAgentDurableObjectName,
} from "~/domains/agents/durable-objects/agent-durable-object.ts";
import type { AgentDurableObject } from "~/domains/agents/durable-objects/agent-durable-object.ts";
import { replayPathCall } from "~/itx/path-proxy.ts";
import type { PathCall } from "~/itx/itx.ts";

type AgentsCapabilityEnv = {
  AGENT?: DurableObjectNamespace<AgentDurableObject>;
  STREAM?: DurableObjectNamespace;
};

type AgentsCapabilityProps = {
  projectId?: string;
};

type AgentRpcStub = {
  sendMessage(input: { channel?: string; message: string }): Promise<{ event: Event }>;
};

/**
 * The PROJECT-scoped agents surface reachable over itx (`itx.agents.*`),
 * mirroring the oRPC project agents router (orpc/routers/agents.ts) so the
 * dashboard can drive agents through itx instead.
 *
 * The critical method is {@link sendMessage}: it routes through the agent
 * Durable Object's own `sendMessage`, which runs `ensureStartedAndCaughtUp()`
 * — so it FORCE-WAKES a cold or never-started agent (creating the DO with
 * `allowCreate: true`) before appending the user message. A raw stream append
 * does NOT do this: it lands an event on a stream nobody is subscribed to yet,
 * because a never-started agent has no live subscriptions. sendMessage is the
 * proven chat path; everything else here is convenience.
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

  /** The project's agents: the child paths of the `/agents` stream tree (no
   * D1 catalog — agents are listed by walking the stream tree). */
  async list(): Promise<{ agentPaths: string[] }> {
    const stream = await this.agentsRootStream();
    const state = await stream.getState();
    return { agentPaths: state.childPaths };
  }

  /** Mirrors oRPC `agents.listPresets`. */
  async listPresets() {
    const stream = await this.agentsRootStream();
    const events = await stream.history({ before: "end" });
    return { presets: readAgentPathPrefixPresets(events) };
  }

  /** Mirrors oRPC `agents.configurePreset`. */
  async configurePreset(input: {
    basePath: string;
    model: string;
    provider: string;
    systemPrompt?: string;
    runOpts?: Record<string, unknown>;
    events?: { type: string; payload: Record<string, unknown> }[];
  }) {
    const basePath = normalizeAgentPresetBasePath(input.basePath);
    const events = [
      ...configuredAgentSetupEvents({
        model: input.model,
        provider: input.provider as AgentLlmProvider,
        runOpts: input.runOpts ?? {},
        systemPrompt: input.systemPrompt ?? "",
      }),
      ...(input.events ?? []),
    ];
    const stream = await this.agentsRootStream();
    await stream.append(presetConfiguredEvent({ basePath, events }));
    return { basePath, eventCount: events.length };
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

  private async agentsRootStream() {
    if (!this.env.STREAM) {
      throw new Error("STREAM Durable Object namespace is not configured.");
    }
    return await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: this.projectId(),
      path: AGENTS_STREAM_PATH,
    });
  }

  private projectId(): string {
    const projectId = this.ctx.props.projectId;
    if (!projectId) throw new Error("AgentsCapability requires ctx.props.projectId.");
    return projectId;
  }
}
