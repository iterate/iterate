import { DurableObject } from "cloudflare:workers";
import { trustedInternalAuthContext } from "../../auth.ts";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "../streams/engine/workers/stream-processor-host.ts";
import { AgentProcessorContract } from "./agent-processor-contract.ts";
import { AgentProcessor } from "./agent-processor-implementation.ts";
import { AgentRpcTarget } from "./rpc-targets.ts";
import type { Agent } from "./types.ts";

export class AgentDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
  readonly #processorHost = createStreamProcessorHost(this.ctx);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    if (!this.#name.path.startsWith("/agents/")) {
      throw new Error(
        `Agent Durable Object path must start with "/agents/", got "${this.#name.path}"`,
      );
    }

    this.#processorHost.add(AgentProcessorContract.slug, (deps) => new AgentProcessor(deps));
  }

  requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    return this.#processorHost.requestStreamSubscription(args);
  }

  getCapability() {
    return new AgentRpcTarget({
      auth: trustedInternalAuthContext(),
      ctx: this.ctx,
      path: this.#name.path,
      projectId: this.#name.projectId,
    });
  }

  get rpcTarget() {
    return this.getCapability();
  }

  get stream() {
    return this.getCapability().stream;
  }

  whoami() {
    return this.getCapability().whoami();
  }

  create() {
    return this.getCapability().create();
  }

  sendMessage(message: string) {
    return this.getCapability().sendMessage(message);
  }

  ask(input: Parameters<Agent["ask"]>[0]) {
    return this.getCapability().ask(input);
  }
}
