// Durable mechanics for one routed GitHub pull-request agent. Kept beside the
// GitHub agent rather than in project bootstrap so the webhook router can
// reconcile an already-existing PR stream after a processor rename.

import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";
import { buildEvent } from "../streams/processor-contracts.ts";
import { buildDurableObjectProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { GithubAgentProcessorContract } from "./github-agent-processor-contract.ts";

const OBSOLETE_GITHUB_AGENT_PROCESSOR_SLUG = "github-pr-agent";

function agentDurableObjectName(input: { agentPath: string; projectId: string }): string {
  return DurableObjectNameCodec.stringify({ path: input.agentPath, projectId: input.projectId });
}

/** The same idempotent subscription fact used by birth and webhook repair. */
export function githubAgentSubscriptionConfiguredEvent(input: {
  agentPath: string;
  projectId: string;
}) {
  const durableObjectName = agentDurableObjectName(input);
  return buildDurableObjectProcessorSubscriptionConfiguredEvent({
    durableObjectName,
    idempotencyKey: `stream/subscription-configured:${durableObjectName}#${GithubAgentProcessorContract.slug}`,
    processor: ["agents", ["get", input.agentPath], "processor"],
    processorSlug: GithubAgentProcessorContract.slug,
  });
}

/**
 * Removes the one obsolete subscription name shipped before `github-agent`.
 * Removal is safe on streams that never had it and keeps repaired streams
 * from permanently advertising a parked subscriber that cannot exist.
 */
export function obsoleteGithubAgentSubscriptionRemovedEvent(input: {
  agentPath: string;
  projectId: string;
}) {
  const durableObjectName = agentDurableObjectName(input);
  return buildEvent({
    contract: CoreProcessorContract,
    event: {
      type: "events.iterate.com/stream/subscription-removed",
      idempotencyKey: `github-agent/remove-obsolete-subscription:${durableObjectName}`,
      payload: {
        subscriptionKey: `${durableObjectName}#${OBSOLETE_GITHUB_AGENT_PROCESSOR_SLUG}`,
      },
    },
  });
}
