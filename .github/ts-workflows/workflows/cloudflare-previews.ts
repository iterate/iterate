import type { Workflow } from "@jlarky/gha-ts/workflow-types";
import { cloudflarePreviewApps } from "../../../scripts/preview/apps.ts";
import * as utils from "../utils/index.ts";

const previewPaths = [...new Set(Object.values(cloudflarePreviewApps).flatMap((app) => app.paths))];
const previewApps = Object.values(cloudflarePreviewApps);
function previewLifecycleConcurrencyGroup(appSlug: string) {
  return `cloudflare-preview-lifecycle-${appSlug}-\${{ github.event.pull_request.number }}`;
}

function createPreviewCommand(input: {
  app?: string;
  command: string;
  includePullRequestBaseSha?: boolean;
  includePullRequestHeadRefName?: boolean;
  includePullRequestHeadSha?: boolean;
  includePullRequestIsFork?: boolean;
  includeSemaphoreBaseUrl?: boolean;
  includeWorkflowRunUrl?: boolean;
  prefix?: string;
}) {
  const argumentsWithLineContinuations = addLineContinuations([
    ...(input.app ? [`--app "${input.app}"`] : []),
    ...createCommonPreviewArguments({
      includePullRequestBaseSha: input.includePullRequestBaseSha ?? false,
      includePullRequestHeadRefName: input.includePullRequestHeadRefName ?? false,
      includePullRequestHeadSha: input.includePullRequestHeadSha ?? false,
      includePullRequestIsFork: input.includePullRequestIsFork ?? false,
      includeSemaphoreBaseUrl: input.includeSemaphoreBaseUrl ?? false,
      includeWorkflowRunUrl: input.includeWorkflowRunUrl ?? false,
    }),
  ]);

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
  includePullRequestBaseSha: boolean;
  includePullRequestHeadRefName: boolean;
  includePullRequestHeadSha: boolean;
  includePullRequestIsFork: boolean;
  includeSemaphoreBaseUrl: boolean;
  includeWorkflowRunUrl: boolean;
}) {
  return [
    '--github-token "$GITHUB_TOKEN"',
    ...(input.includePullRequestHeadRefName
      ? ['--pull-request-head-ref-name "${{ github.event.pull_request.head.ref }}"']
      : []),
    ...(input.includePullRequestHeadSha
      ? ['--pull-request-head-sha "${{ github.event.pull_request.head.sha }}"']
      : []),
    ...(input.includePullRequestBaseSha
      ? ['--pull-request-base-sha "${{ github.event.pull_request.base.sha }}"']
      : []),
    '--pull-request-number "${{ github.event.pull_request.number }}"',
    '--repository-full-name "${{ github.repository }}"',
    ...(input.includePullRequestIsFork
      ? ["--is-fork \"${{ github.event.pull_request.head.repo.fork && 'true' || 'false' }}\""]
      : []),
    ...(input.includeWorkflowRunUrl ? ['--workflow-run-url "$WORKFLOW_RUN_URL"'] : []),
    ...(input.includeSemaphoreBaseUrl ? ['--semaphore-base-url "$SEMAPHORE_BASE_URL"'] : []),
  ];
}

function createPreviewLifecycleJob(input: {
  appSlug: string;
  command: string;
  name: string;
  needs: string[];
  if: string;
  runsOnDoppler?: boolean;
  runsOnForks?: boolean;
}) {
  return {
    needs: input.needs,
    if: input.if,
    name: input.name,
    ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
    concurrency: {
      group: previewLifecycleConcurrencyGroup(input.appSlug),
      "cancel-in-progress": false,
    },
    steps: [
      ...utils.getSetupRepo({
        ref: "${{ github.event.pull_request.head.sha || github.sha }}",
      }),
      {
        ...utils.installDopplerCli,
        if: "github.event.pull_request.head.repo.fork != true",
      },
      ...(input.runsOnForks
        ? [
            {
              if: "github.event.pull_request.head.repo.fork == true",
              name: `${input.name} for forks`,
              env: {
                GITHUB_TOKEN: "${{ secrets.ITERATE_BOT_GITHUB_TOKEN || github.token }}",
                SEMAPHORE_BASE_URL: "https://semaphore.iterate.com",
                WORKFLOW_RUN_URL:
                  "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
              },
              run: createPreviewCommand({
                app: input.appSlug,
                command: input.command,
                includePullRequestBaseSha: input.command === "deploy",
                includePullRequestHeadRefName: input.command === "deploy",
                includePullRequestHeadSha: input.command !== "cleanup",
                includePullRequestIsFork: input.command === "deploy",
                includeSemaphoreBaseUrl: true,
                includeWorkflowRunUrl: true,
              }),
            },
          ]
        : []),
      ...(input.runsOnDoppler
        ? [
            {
              if: "github.event.pull_request.head.repo.fork != true",
              name: input.name,
              env: {
                DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
                GITHUB_TOKEN: "${{ secrets.ITERATE_BOT_GITHUB_TOKEN || github.token }}",
                WORKFLOW_RUN_URL:
                  "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
              },
              run: createPreviewCommand({
                app: input.appSlug,
                command: input.command,
                includePullRequestBaseSha: input.command === "deploy",
                includePullRequestHeadRefName: input.command === "deploy",
                includePullRequestHeadSha: input.command !== "cleanup",
                includePullRequestIsFork: input.command === "deploy",
                includeWorkflowRunUrl: input.command !== "cleanup",
                prefix: "doppler run --project os --config prd -- ",
              }),
            },
          ]
        : []),
    ],
  } satisfies Workflow["jobs"][string];
}

function createPreviewJobs() {
  return Object.fromEntries(
    previewApps.flatMap((app) => [
      [
        `preview-${app.slug}`,
        createPreviewLifecycleJob({
          appSlug: app.slug,
          command: "deploy",
          if: "needs.scope.outputs.should_run == 'true' && github.event.action != 'closed'",
          name: `Preview / ${app.slug} deploy`,
          needs: ["scope"],
          runsOnDoppler: true,
          runsOnForks: true,
        }),
      ],
      [
        `e2e-${app.slug}`,
        createPreviewLifecycleJob({
          appSlug: app.slug,
          command: "test",
          if: "needs.scope.outputs.should_run == 'true' && github.event.action != 'closed' && github.event.pull_request.head.repo.fork != true",
          name: `Preview / ${app.slug} e2e`,
          needs: [`preview-${app.slug}`],
          runsOnDoppler: true,
        }),
      ],
      [
        `cleanup-${app.slug}`,
        createPreviewLifecycleJob({
          appSlug: app.slug,
          command: "cleanup",
          if: "needs.scope.outputs.should_run == 'true' && github.event.action == 'closed' && github.event.pull_request.head.repo.fork != true",
          name: `Preview / ${app.slug} cleanup`,
          needs: ["scope"],
          runsOnDoppler: true,
        }),
      ],
    ]),
  );
}

export default {
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
    },
  },
  jobs: {
    scope: {
      ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
      outputs: {
        should_run: "${{ steps.should_run_preview.outputs.result }}",
      },
      steps: [
        await utils.githubScript(
          import.meta,
          {
            params: {
              previewPaths,
            },
            "result-encoding": "string",
          },
          async function should_run_preview({ context, github }) {
            const pullRequest = context.payload.pull_request;
            if (!pullRequest) {
              return "false";
            }

            if (context.payload.action === "closed") {
              return "true";
            }

            const files: Array<{ filename: string }> = [];
            let page = 1;

            while (true) {
              const response = await github.rest.pulls.listFiles({
                owner: context.repo.owner,
                page,
                per_page: 100,
                pull_number: pullRequest.number,
                repo: context.repo.repo,
              });

              files.push(...response.data.map((file) => ({ filename: file.filename })));
              if (response.data.length < 100) {
                break;
              }

              page += 1;
            }

            const matchesPreviewPath = (filename: string) =>
              previewPaths.some((pattern) =>
                pattern.endsWith("/**")
                  ? filename.startsWith(pattern.slice(0, -2))
                  : filename === pattern,
              );

            return files.some((file) => matchesPreviewPath(file.filename)) ? "true" : "false";
          },
        ),
      ],
    },
    ...createPreviewJobs(),
  },
} satisfies Workflow;
