import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import {
  createStreamProcessorHost,
  type StreamSubscriberWakeRequest,
} from "../streams/stream-processor-host.ts";
import { StreamProcessorRpcTarget } from "../../rpc-targets.ts";
import { StreamRpcTarget } from "../../rpc-targets.ts";
import { AgentProcessorContract } from "./agent-processor-contract.ts";
import { AgentProcessor } from "./agent-processor-implementation.ts";
import { CloudflareAiProcessorContract } from "./cloudflare-ai-processor-contract.ts";
import { CloudflareAiProcessor } from "./cloudflare-ai-processor-implementation.ts";
import { parseAgentDurableObjectName } from "./utils.ts";

export class AgentDurableObject extends DurableObject<Env> {
  readonly #name = parseAgentDurableObjectName(this.ctx.id.name!);
  readonly #stream = new StreamRpcTarget({
    auth: trustedInternalAuthContext(),
    path: this.#name.path,
    projectId: this.#name.projectId,
  });
  readonly #processorHost = createStreamProcessorHost(this.ctx, {
    stream: this.#stream,
  });
  readonly #agentProcessor = this.#processorHost.add(
    AgentProcessorContract.slug,
    (deps) => new AgentProcessor(deps),
  );
  readonly cloudflareAiProcessor = this.#processorHost.add(
    CloudflareAiProcessorContract.slug,
    (deps) =>
      new CloudflareAiProcessor({
        ...deps,
        ai: this.env.AI,
        readStreamEvents: () => this.#stream.getEvents(),
      }),
  );

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<void> {
    return this.#processorHost.wakeStreamSubscriber(args);
  }

  get processor() {
    return new StreamProcessorRpcTarget(this.#agentProcessor);
  }
}
