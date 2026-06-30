import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import {
  createStreamProcessorHost,
  type StreamSubscriberWakeRequest,
} from "../streams/stream-processor-host.ts";
import { StreamRpcTarget } from "../../rpc-targets.ts";
import { AgentProcessorContract } from "./agent-processor-contract.ts";
import { AgentProcessor } from "./agent-processor-implementation.ts";
import { parseAgentDurableObjectName } from "./utils.ts";

export class AgentDurableObject extends DurableObject<Env> {
  readonly #name = parseAgentDurableObjectName(this.ctx.id.name!);
  readonly #processorHost = createStreamProcessorHost(this.ctx, {
    stream: new StreamRpcTarget({
      auth: trustedInternalAuthContext(),
      path: this.#name.path,
      projectId: this.#name.projectId,
    }),
  });
  readonly #agentProcessor = this.#processorHost.add(
    AgentProcessorContract.slug,
    (deps) => new AgentProcessor(deps),
  );

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<void> {
    return this.#processorHost.wakeStreamSubscriber(args);
  }

  get processor() {
    return this.#agentProcessor;
  }
}
