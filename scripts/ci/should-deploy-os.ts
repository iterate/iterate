import { appendFileSync } from "node:fs";
import { isMainModule } from "../../packages/shared/src/dev/is-main-module.ts";

export const SKIP_MAIN_CI_DEPLOY_LABEL = "skip-main-ci-deploy";

type PullRequest = {
  number: number;
  labels: Array<{ name: string }>;
};

export async function shouldDeployOs(input: {
  eventName: string;
  repository?: string;
  sha?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ shouldDeploy: boolean; reason: string }> {
  if (input.eventName !== "push") {
    return { shouldDeploy: true, reason: `${input.eventName} is an explicit deployment` };
  }
  if (!input.repository || !input.sha || !input.token) {
    throw new Error("GITHUB_REPOSITORY, GITHUB_SHA, and GITHUB_TOKEN are required for a push gate");
  }

  const response = await (input.fetchImpl ?? fetch)(
    `https://api.github.com/repos/${input.repository}/commits/${input.sha}/pulls`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.token}`,
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Could not inspect pull requests for ${input.sha} (${response.status}): ${(await response.text()).slice(0, 500)}`,
    );
  }

  const pullRequests = (await response.json()) as PullRequest[];
  const gated = pullRequests.filter((pullRequest) =>
    pullRequest.labels.some((label) => label.name === SKIP_MAIN_CI_DEPLOY_LABEL),
  );
  if (gated.length > 0) {
    return {
      shouldDeploy: false,
      reason: `PR ${gated.map((pullRequest) => `#${pullRequest.number}`).join(", ")} carries ${SKIP_MAIN_CI_DEPLOY_LABEL}`,
    };
  }
  return {
    shouldDeploy: true,
    reason:
      pullRequests.length === 0
        ? "main commit is not associated with a pull request"
        : "associated pull request does not skip deployment",
  };
}

async function main() {
  const result = await shouldDeployOs({
    eventName: process.env.GITHUB_EVENT_NAME ?? "",
    repository: process.env.GITHUB_REPOSITORY,
    sha: process.env.GITHUB_SHA,
    token: process.env.GITHUB_TOKEN,
  });
  console.log(result.reason);
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is required");
  appendFileSync(output, `should_deploy=${result.shouldDeploy}\nreason=${result.reason}\n`);
}

if (isMainModule(import.meta.url)) await main();
