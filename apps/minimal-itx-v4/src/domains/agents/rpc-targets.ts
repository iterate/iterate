import { env, RpcTarget } from "cloudflare:workers";
import { DurableObjectNameCodec, normalizePath } from "../durable-object-names.ts";
import { StreamRpcTarget } from "../streams/rpc-targets.ts";
import { subscriptionConfiguredEvent } from "../streams/subscription-event.ts";
import { ItxProcessorContract } from "../itx/itx-processor-contract.ts";
import { type ProvideCapabilityInput } from "../itx/itx-processor-implementation.ts";
import { rejectBuiltinCollision, withInvokeCapabilityFallback } from "../itx/path-proxy.ts";
import type { CfExecutionContext, ItxAuth } from "../itx/types.ts";
import { AgentProcessorContract } from "./agent-processor-contract.ts";
import type { Agent, AgentCollection } from "./types.ts";

function normalizeAgentPath(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized.startsWith("/agents/")) {
    throw new Error(`agent path must start with "/agents/", got "${normalized}"`);
  }
  return normalized;
}

export class AgentCollectionRpcTarget extends RpcTarget implements AgentCollection {
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

class AgentRpcTarget extends RpcTarget implements Agent {
  constructor(
    readonly props: { auth: ItxAuth; ctx: CfExecutionContext; path: string; projectId: string },
  ) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
    props.path = normalizeAgentPath(props.path);
    return withInvokeCapabilityFallback(this);
  }

  #itx() {
    return env.ITX.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.props.projectId,
        path: this.props.path,
      }),
    );
  }

  #projectItx() {
    return env.ITX.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.props.projectId,
        path: "/",
      }),
    );
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

  async provideCapability(input: ProvideCapabilityInput) {
    rejectBuiltinCollision(this, input.path);
    await this.#ensureProcessorsConfigured();
    await this.#itx().provideCapability(input);
    return {
      revoke: async () => {
        await this.#itx().revokeCapability({ path: input.path });
      },
    };
  }

  async revokeCapability(input: { path: string[] }) {
    await this.#ensureProcessorsConfigured();
    await this.#itx().revokeCapability(input);
  }

  async runScript(code: string) {
    await this.#ensureProcessorsConfigured();
    return await this.#itx().runScript(code);
  }

  async invokeCapability({ args = [], path }: { args?: unknown[]; path: string[] }) {
    await this.#ensureProcessorsConfigured();
    try {
      return await this.#itx().invokeCapability({ args, path });
    } catch (error) {
      if (!isMissingCapabilityError(error, path)) throw error;
      return await this.#projectItx().invokeCapability({ args, path });
    }
  }

  // Configure this agent's AGENT + ITX processors on its stream the first time
  // any capability op runs. `subscriptionKey` is the sole identity (no
  // idempotency key), so we append only the subscriptions the stream's reduced
  // state doesn't already carry — re-running this is then a cheap no-op.
  async #ensureProcessorsConfigured() {
    const desired = [
      subscriptionConfiguredEvent({
        projectId: this.props.projectId,
        path: this.props.path,
        bindingName: "AGENT",
        processorName: AgentProcessorContract.slug,
      }),
      subscriptionConfiguredEvent({
        projectId: this.props.projectId,
        path: this.props.path,
        bindingName: "ITX",
        processorName: ItxProcessorContract.slug,
      }),
    ];
    const { coreProcessorState } = await this.stream.runtimeState();
    const missing = desired.filter(
      (event) => !(event.payload.subscriptionKey in coreProcessorState.subscriptionsByKey),
    );
    if (missing.length > 0) {
      await this.stream.append(...missing);
    }
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
