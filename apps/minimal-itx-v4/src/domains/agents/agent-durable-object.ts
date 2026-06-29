import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "../streams/engine/workers/stream-processor-host.ts";
import { AgentProcessorContract } from "./agent-processor-contract.ts";
import { AgentProcessor } from "./agent-processor-implementation.ts";

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
}
