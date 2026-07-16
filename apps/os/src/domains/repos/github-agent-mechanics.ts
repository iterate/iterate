// Explicit creation batch for one routed GitHub pull-request agent. Kept
// beside the GitHub facet because the repo router owns its birth.

import { agentCreationForPath, PR_AGENT_SYSTEM_PROMPT } from "../agents/agent-defaults.ts";
import type { EmittedInput } from "iterate/processor-contracts";
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
  return agentCreationForPath({
    agentPath: input.path,
    projectId: input.projectId,
    overrides: { systemPrompt: PR_AGENT_SYSTEM_PROMPT },
    sibling: {
      birthCertificate: GithubAgentProcessorContract.buildEvent({
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
      }),
      processorSlug: GithubAgentProcessorContract.slug,
    },
  }).events satisfies EmittedInput<RepoProcessorContract>[];
}
