import { uses, type Step, type Workflow } from "@jlarky/gha-ts/workflow-types";
import {
  cloudflarePreviewApps,
  cloudflarePreviewAdditionalTriggerPaths,
  cloudflarePreviewSharedPaths,
} from "../../../scripts/preview/apps.ts";
import * as utils from "../utils/index.ts";

const previewPaths = [
  ...new Set([
    ...cloudflarePreviewSharedPaths,
    ...cloudflarePreviewAdditionalTriggerPaths,
    ...Object.values(cloudflarePreviewApps).flatMap((app) => app.paths),
  ]),
];

function createPreviewCommand(input: {
  command: string;
  includePullRequestBaseSha?: boolean;
  includePullRequestHeadRefName?: boolean;
  includePullRequestHeadSha?: boolean;
  includePullRequestIsFork?: boolean;
  includeSemaphoreBaseUrl?: boolean;
  includeWorkflowRunUrl?: boolean;
  prefix?: string;
}) {
  const lines = createCommonPreviewArguments({
    includePullRequestBaseSha: input.includePullRequestBaseSha ?? false,
    includePullRequestHeadRefName: input.includePullRequestHeadRefName ?? false,
    includePullRequestHeadSha: input.includePullRequestHeadSha ?? false,
    includePullRequestIsFork: input.includePullRequestIsFork ?? false,
    includeSemaphoreBaseUrl: input.includeSemaphoreBaseUrl ?? false,
    includeWorkflowRunUrl: input.includeWorkflowRunUrl ?? false,
  });
  const argumentsWithLineContinuations = lines.map((line, index) =>
    index === lines.length - 1 ? `  ${line}` : `  ${line} \\`,
  );

  return [
    "set -euo pipefail",
    `${input.prefix ?? ""}pnpm preview ${input.command} \\`,
    ...argumentsWithLineContinuations,
  ].join("\n");
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

function createDopplerPreviewStep(input: { name: string; run: string }): Step {
  return {
    if: "github.event.pull_request.head.repo.fork != true",
    name: input.name,
    env: {
      DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
      GITHUB_TOKEN: "${{ secrets.ITERATE_BOT_GITHUB_TOKEN || github.token }}",
      WORKFLOW_RUN_URL:
        "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
    },
    run: input.run,
  };
}

function createForkPreviewDeployStep(): Step {
  return {
    if: "github.event.pull_request.head.repo.fork == true",
    name: "Preview / deploy for forks",
    env: {
      GITHUB_TOKEN: "${{ secrets.ITERATE_BOT_GITHUB_TOKEN || github.token }}",
      SEMAPHORE_BASE_URL: "https://semaphore.iterate.com",
      WORKFLOW_RUN_URL:
        "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
    },
    run: createPreviewCommand({
      command: "deploy",
      includePullRequestBaseSha: true,
      includePullRequestHeadRefName: true,
      includePullRequestHeadSha: true,
      includePullRequestIsFork: true,
      includeSemaphoreBaseUrl: true,
      includeWorkflowRunUrl: true,
    }),
  };
}

function createDopplerPreviewDeployStep(): Step {
  return createDopplerPreviewStep({
    name: "Preview / deploy",
    run: createPreviewCommand({
      command: "deploy",
      includePullRequestBaseSha: true,
      includePullRequestHeadRefName: true,
      includePullRequestHeadSha: true,
      includePullRequestIsFork: true,
      includeWorkflowRunUrl: true,
      prefix: "doppler run --project _shared --config prd -- ",
    }),
  });
}

function createDopplerPreviewTestStep(): Step {
  return createDopplerPreviewStep({
    name: "Preview / e2e",
    run: createPreviewCommand({
      command: "test",
      includePullRequestHeadSha: true,
      includeWorkflowRunUrl: true,
      prefix: "doppler run --project _shared --config prd -- ",
    }),
  });
}

function createDopplerPreviewCleanupStep(): Step {
  return createDopplerPreviewStep({
    name: "Preview / cleanup",
    run: createPreviewCommand({
      command: "cleanup",
      prefix: "doppler run --project _shared --config prd -- ",
    }),
  });
}

function createPreviewLifecycleJob(input: { if: string; name: string; steps: Step[] }) {
  return {
    if: input.if,
    name: input.name,
    ...utils.runsOnDepotUbuntu64,
    concurrency: {
      group: `cloudflare-preview-lifecycle-\${{ github.event.pull_request.number }}`,
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
      ...input.steps,
    ],
  } satisfies Workflow["jobs"][string];
}

function createPreviewDeployAndTestJob() {
  return createPreviewLifecycleJob({
    if: "github.event.action != 'closed'",
    name: "Preview / deploy + e2e",
    steps: [
      createForkPreviewDeployStep(),
      createDopplerPreviewDeployStep(),
      createDopplerPreviewTestStep(),
      ...createPreviewTestArtifactSteps(),
    ],
  });
}

function createPreviewCleanupJob() {
  return createPreviewLifecycleJob({
    if: "github.event.action == 'closed' && github.event.pull_request.head.repo.fork != true",
    name: "Preview / cleanup",
    steps: [createDopplerPreviewCleanupStep()],
  });
}

function createPreviewTestArtifactSteps(): Step[] {
  return Object.values(cloudflarePreviewApps).flatMap((app) => {
    if (!app.previewTestArtifacts) return [];

    return {
      name: `Upload ${app.displayName} preview test artifacts`,
      if: "always() && github.event.pull_request.head.repo.fork != true",
      ...uses("actions/upload-artifact@v4", {
        name: `preview-${app.slug}-test-artifacts`,
        path: app.previewTestArtifacts.join("\n"),
        "if-no-files-found": "ignore",
      }),
    };
  });
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
      paths: previewPaths,
    },
  },
  jobs: {
    // Deploy and e2e share one job: a separate e2e job paid ~80s of runner
    // pickup plus checkout/install before running a single test. The e2e step
    // is doppler-only, so forks still deploy and simply skip it.
    preview: createPreviewDeployAndTestJob(),
    cleanup: createPreviewCleanupJob(),
  },
} satisfies Workflow;
