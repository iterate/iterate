import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  createStreamProcessorHost,
  type StreamSubscriberWakeRequest,
} from "../streams/stream-processor-host.ts";
import { StreamRpcTarget } from "../../rpc-targets.ts";
import { AgentProcessorContract } from "./agent-processor-contract.ts";
import { AgentProcessor } from "./agent-processor-implementation.ts";

export class AgentDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
  readonly #processorHost = createStreamProcessorHost(this.ctx, {
    stream: new StreamRpcTarget({
      auth: trustedInternalAuthContext(),
      path: this.#name.path,
      projectId: this.#name.projectId,
    }),
  });
  readonly #agentProcessor: AgentProcessor;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    if (!this.#name.path.startsWith("/agents/")) {
      throw new Error(
        `Agent Durable Object path must start with "/agents/", got "${this.#name.path}"`,
      );
    }

    this.#agentProcessor = this.#processorHost.add(
      AgentProcessorContract.slug,
      (deps) => new AgentProcessor(deps),
    );
  }

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<void> {
    return this.#processorHost.wakeStreamSubscriber(args);
  }

  get processor() {
    return this.#agentProcessor;
  }
}
