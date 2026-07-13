// Durable mechanics for one routed GitHub pull-request agent. Kept beside the
// GitHub agent rather than in project bootstrap so every webhook can repair
// the current stream's subscription before forwarding the event.

import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { buildDurableObjectProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { GithubAgentProcessorContract } from "./github-agent-processor-contract.ts";

/** The same idempotent subscription fact used by birth and webhook repair. */
export function githubAgentSubscriptionConfiguredEvent(input: {
  agentPath: string;
  projectId: string;
}) {
  const durableObjectName = DurableObjectNameCodec.stringify({
    path: input.agentPath,
    projectId: input.projectId,
  });
  return buildDurableObjectProcessorSubscriptionConfiguredEvent({
    durableObjectName,
    idempotencyKey: `stream/subscription-configured:${durableObjectName}#${GithubAgentProcessorContract.slug}`,
    processor: ["agents", ["get", input.agentPath], "processor"],
    processorSlug: GithubAgentProcessorContract.slug,
  });
}
