import { workflow } from "@jlarky/gha-ts/workflow-types";
import { cloudflarePreviewApps } from "../../../scripts/preview/apps.ts";
import * as utils from "../utils/index.ts";

const previewPaths = [...new Set(Object.values(cloudflarePreviewApps).flatMap((app) => app.paths))];

function createPreviewCommand(input: {
  command: string;
  includePullRequestHead?: boolean;
  includeSemaphoreBaseUrl?: boolean;
  includeWorkflowRunUrl?: boolean;
  prefix?: string;
}) {
  const argumentsWithLineContinuations = addLineContinuations(
    createCommonPreviewArguments({
      includePullRequestHead: input.includePullRequestHead ?? false,
      includeSemaphoreBaseUrl: input.includeSemaphoreBaseUrl ?? false,
      includeWorkflowRunUrl: input.includeWorkflowRunUrl ?? false,
    }),
  );

  return [
    "set -euo pipefail",
    `${input.prefix ?? ""}pnpm preview ${input.command} \\`,
    ...argumentsWithLineContinuations,
  ].join("\n");
}

function addLineContinuations(lines: string[]) {
  return lines.map((line, index) => (index === lines.length - 1 ? `  ${line}` : `  ${line} \\`));
}

function createCommonPreviewArguments(input: {
  includePullRequestHead: boolean;
  includeSemaphoreBaseUrl: boolean;
  includeWorkflowRunUrl: boolean;
}) {
  return [
    '--github-token "$GITHUB_TOKEN"',
    ...(input.includePullRequestHead
      ? [
          '--pull-request-head-ref-name "${{ github.event.pull_request.head.ref }}"',
          '--pull-request-head-sha "${{ github.event.pull_request.head.sha }}"',
          '--pull-request-base-sha "${{ github.event.pull_request.base.sha }}"',
        ]
      : []),
    '--pull-request-number "${{ github.event.pull_request.number }}"',
    '--repository-full-name "${{ github.repository }}"',
    ...(input.includePullRequestHead
      ? ["--is-fork \"${{ github.event.pull_request.head.repo.fork && 'true' || 'false' }}\""]
      : []),
    ...(input.includeWorkflowRunUrl ? ['--workflow-run-url "$WORKFLOW_RUN_URL"'] : []),
    ...(input.includeSemaphoreBaseUrl ? ['--semaphore-base-url "$SEMAPHORE_BASE_URL"'] : []),
  ];
}

export default workflow({
  name: "Cloudflare Previews",
  permissions: {
    contents: "read",
    "pull-requests": "write",
  },
  concurrency: {
    group: `cloudflare-previews-\${{ github.event.pull_request.number }}`,
    "cancel-in-progress": true,
  },
  on: {
    pull_request: {
      types: ["opened", "reopened", "synchronize", "closed"],
      paths: previewPaths,
    },
  },
  jobs: {
    preview: {
      ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
      steps: [
        ...utils.getSetupRepo({
          ref: "${{ github.event.pull_request.head.sha || github.sha }}",
        }),
        {
          ...utils.installDopplerCli,
          if: "github.event.pull_request.head.repo.fork != true",
        },
        {
          if: "github.event.action != 'closed' && github.event.pull_request.head.repo.fork == true",
          name: "Sync previews for forks",
          env: {
            GITHUB_TOKEN: "${{ secrets.ITERATE_BOT_GITHUB_TOKEN || github.token }}",
            SEMAPHORE_BASE_URL: "https://semaphore.iterate.com",
            WORKFLOW_RUN_URL:
              "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
          },
          run: createPreviewCommand({
            command: "sync-all",
            includePullRequestHead: true,
            includeSemaphoreBaseUrl: true,
            includeWorkflowRunUrl: true,
          }),
        },
        {
          if: "github.event.action != 'closed' && github.event.pull_request.head.repo.fork != true",
          name: "Sync previews",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            GITHUB_TOKEN: "${{ secrets.ITERATE_BOT_GITHUB_TOKEN || github.token }}",
            WORKFLOW_RUN_URL:
              "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
          },
          run: createPreviewCommand({
            command: "sync-all",
            includePullRequestHead: true,
            includeWorkflowRunUrl: true,
            prefix: "doppler run --project os --config prd -- ",
          }),
        },
        {
          if: "github.event.action == 'closed' && github.event.pull_request.head.repo.fork != true",
          name: "Cleanup previews",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            GITHUB_TOKEN: "${{ secrets.ITERATE_BOT_GITHUB_TOKEN || github.token }}",
          },
          run: createPreviewCommand({
            command: "cleanup-all",
            prefix: "doppler run --project os --config prd -- ",
          }),
        },
      ],
    },
  },
});
