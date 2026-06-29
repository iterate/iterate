import { env, RpcTarget } from "cloudflare:workers";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { durableObjectProcessorSubscriber } from "../streams/engine/shared/callable-subscriber.ts";
import { StreamRpcTarget } from "../streams/rpc-targets.ts";
import { ItxCapabilityHostRpcTarget } from "../itx/capability-host-rpc-target.ts";
import { ItxProcessorContract } from "../itx/itx-processor-contract.ts";
import {
  type ItxProcessorRpc,
  type ProvideCapabilityInput,
} from "../itx/itx-processor-implementation.ts";
import { withInvokeCapabilityFallback } from "../itx/path-proxy.ts";
import type { CfExecutionContext, RpcTargetImplementation } from "../../rpc-target-types.ts";
import type { ItxAuth } from "../itx/types.ts";
import type { Stream } from "../streams/types.ts";
import { AgentProcessorContract } from "./agent-processor-contract.ts";
import type { Agent, AgentCollection } from "./types.ts";

function normalizeAgentPath(path: string): string {
  const normalized = path === "" ? "/" : path.startsWith("/") ? path : `/${path}`;
  if (!normalized.startsWith("/agents/")) {
    throw new Error(`agent path must start with "/agents/", got "${normalized}"`);
  }
  return normalized;
}

function agentProcessorSubscriptionEvent(input: { path: string; projectId: string }) {
  const path = normalizeAgentPath(input.path);
  return {
    type: "events.iterate.com/stream/subscription-configured",
    idempotencyKey: `stream-subscription:${input.projectId}:${path}:${AgentProcessorContract.slug}`,
    payload: {
      subscriptionKey: AgentProcessorContract.slug,
      subscriber: durableObjectProcessorSubscriber({
        bindingName: "AGENT",
        durableObjectName: DurableObjectNameCodec.stringify({
          projectId: input.projectId,
          path,
        }),
        processorName: AgentProcessorContract.slug,
      }),
    },
  } satisfies Parameters<Stream["append"]>[0];
}

function agentItxProcessorSubscriptionEvent(input: { path: string; projectId: string }) {
  const path = normalizeAgentPath(input.path);
  return {
    type: "events.iterate.com/stream/subscription-configured",
    idempotencyKey: `stream-subscription:${input.projectId}:${path}:${ItxProcessorContract.slug}`,
    payload: {
      subscriptionKey: ItxProcessorContract.slug,
      subscriber: durableObjectProcessorSubscriber({
        bindingName: "AGENT",
        durableObjectName: DurableObjectNameCodec.stringify({
          projectId: input.projectId,
          path,
        }),
        processorName: ItxProcessorContract.slug,
      }),
    },
  } satisfies Parameters<Stream["append"]>[0];
}

export class AgentCollectionRpcTarget
  extends RpcTarget
  implements RpcTargetImplementation<AgentCollection>
{
  constructor(readonly props: { auth: ItxAuth; ctx: CfExecutionContext; projectId: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  async create(input: Parameters<AgentCollection["create"]>[0]) {
    return await this.get(input.path).create();
  }

  get(path: string) {
    return new AgentRpcTarget({
      auth: this.props.auth,
      ctx: this.props.ctx,
      path: normalizeAgentPath(path),
      projectId: this.props.projectId,
    });
  }
}

export class AgentRpcTarget
  extends ItxCapabilityHostRpcTarget
  implements RpcTargetImplementation<Agent>
{
  constructor(
    readonly props: { auth: ItxAuth; ctx: CfExecutionContext; path: string; projectId: string },
  ) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
    props.path = normalizeAgentPath(props.path);
    return withInvokeCapabilityFallback(this);
  }

  get durableObjectStub() {
    return env.AGENT.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.props.projectId,
        path: this.props.path,
      }),
    );
  }

  protected itxProcessor(): ItxProcessorRpc {
    return this.durableObjectStub.itxProcessor as unknown as ItxProcessorRpc;
  }

  #projectItxProcessor(): ItxProcessorRpc {
    return env.PROJECT.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.props.projectId,
        path: "/",
      }),
    ).itxProcessor as unknown as ItxProcessorRpc;
  }

  get stream() {
    return new StreamRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
      path: this.props.path,
    });
  }

  async create() {
    await this.#ensureProcessorsConfigured();
    const [requested] = await this.stream.append({
      type: "events.iterate.com/agent/create-requested",
      idempotencyKey: `agent-create-requested:${this.props.projectId}:${this.props.path}`,
      payload: {},
    });
    return await this.stream.waitForEvent({
      afterOffset: requested.offset - 1,
      eventTypes: ["events.iterate.com/agent/created"],
      timeoutMs: 30_000,
    });
  }

  async sendMessage(message: string) {
    await this.#ensureProcessorsConfigured();
    const [event] = await this.stream.append({
      type: "events.iterate.com/agents/user-message-received",
      payload: { content: message, origin: "web" },
    });
    return event;
  }

  async ask(input: Parameters<Agent["ask"]>[0]) {
    const sent = await this.sendMessage(input.message);
    return await this.stream.waitForEvent({
      afterOffset: sent.offset,
      eventTypes: ["events.iterate.com/agents/web-message-sent"],
      timeoutMs: 45_000,
    });
  }

  whoami() {
    return `agent ${this.props.projectId}:${this.props.path}`;
  }

  override async provideCapability(input: ProvideCapabilityInput) {
    await this.#ensureProcessorsConfigured();
    return await super.provideCapability(input);
  }

  override async revokeCapability(input: { path: string[] }) {
    await this.#ensureProcessorsConfigured();
    return await super.revokeCapability(input);
  }

  override async runScript(code: string) {
    await this.#ensureProcessorsConfigured();
    return await super.runScript(code);
  }

  override async invokeCapability({ args = [], path }: { args?: unknown[]; path: string[] }) {
    await this.#ensureProcessorsConfigured();
    try {
      return await this.itxProcessor().invokeCapability({ args, path });
    } catch (error) {
      if (!isMissingCapabilityError(error, path)) throw error;
      return await this.#projectItxProcessor().invokeCapability({ args, path });
    }
  }

  async #ensureProcessorsConfigured() {
    await this.stream.append(
      agentProcessorSubscriptionEvent({
        path: this.props.path,
        projectId: this.props.projectId,
      }),
      agentItxProcessorSubscriptionEvent({
        path: this.props.path,
        projectId: this.props.projectId,
      }),
    );
  }
}

function isMissingCapabilityError(error: unknown, path: string[]): boolean {
  const message =
    error instanceof Error
      ? error.message
      : error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : String(error);
  return message.includes(`no capability "${path.join(".")}"`);
}
