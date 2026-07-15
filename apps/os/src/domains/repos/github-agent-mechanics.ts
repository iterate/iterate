// Explicit creation batch for one routed GitHub pull-request agent. Kept
// beside the GitHub facet because the repo router owns its birth.

import { agentDefaultsForPath, PR_AGENT_SYSTEM_PROMPT } from "../agents/agent-defaults.ts";
import { AgentProcessorContract } from "../agents/agent-processor-contract.ts";
import { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import type { EmittedInput } from "../streams/processor-contracts.ts";
import { buildDurableObjectProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { GithubAgentProcessorContract } from "./github-agent-processor-contract.ts";
import type { RepoProcessorContract } from "./repo-processor-contract.ts";

export function githubAgentCreationEvents(input: {
  connection: string;
  installationId: string;
  number: number;
  owner: string;
  path: string;
  projectId: string;
  repo: string;
  repoPath: string;
}): EmittedInput<RepoProcessorContract>[] {
  const policy = agentDefaultsForPath({
    agentPath: input.path,
    projectId: input.projectId,
    overrides: { systemPrompt: PR_AGENT_SYSTEM_PROMPT },
  });
  const [agentCreated, capabilityHostCreated, ...setupEvents] = policy.events;
  if (agentCreated === undefined || capabilityHostCreated === undefined) {
    throw new Error("Agent creation policy did not contain its required birth events");
  }
  const durableObjectName = DurableObjectNameCodec.stringify({
    path: input.path,
    projectId: input.projectId,
  });
  return [
    agentCreated,
    capabilityHostCreated,
    {
      type: "events.iterate.com/github-agent/created",
      idempotencyKey: `github-agent/created:${input.projectId}:${input.path}`,
      payload: {
        config: {
          connection: input.connection,
          installationId: input.installationId,
          number: input.number,
          owner: input.owner,
          repo: input.repo,
          repoPath: input.repoPath,
        },
      },
    },
    ...setupEvents,
    buildDurableObjectProcessorSubscriptionConfiguredEvent({
      durableObjectName,
      idempotencyKey: `stream/subscription-configured:${durableObjectName}#${AgentProcessorContract.slug}`,
      processor: ["agents", ["get", input.path], "processor"],
      processorSlug: AgentProcessorContract.slug,
    }),
    buildDurableObjectProcessorSubscriptionConfiguredEvent({
      durableObjectName,
      idempotencyKey: `stream/subscription-configured:${durableObjectName}#${CapabilityHostProcessorContract.slug}`,
      processor: ["capabilityHosts", ["get", input.path], "processor"],
      processorSlug: CapabilityHostProcessorContract.slug,
    }),
    buildDurableObjectProcessorSubscriptionConfiguredEvent({
      durableObjectName,
      idempotencyKey: `stream/subscription-configured:${durableObjectName}#${GithubAgentProcessorContract.slug}`,
      processor: ["agents", ["get", input.path], "processor"],
      processorSlug: GithubAgentProcessorContract.slug,
    }),
  ] as EmittedInput<RepoProcessorContract>[];
}
