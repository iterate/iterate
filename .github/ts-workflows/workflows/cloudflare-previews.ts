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

function createDopplerStep(input: { command: string; name: string }): Step {
  return {
    if: "github.event.pull_request.head.repo.fork != true",
    name: input.name,
    env: {
      DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
      GITHUB_TOKEN: "${{ secrets.ITERATE_BOT_GITHUB_TOKEN || github.token }}",
      WORKFLOW_RUN_URL:
        "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
    },
    run: createPreviewCommand({
      command: input.command,
      includePullRequestBaseSha: input.command === "deploy",
      includePullRequestHeadRefName: input.command === "deploy",
      includePullRequestHeadSha: input.command !== "cleanup",
      includePullRequestIsFork: input.command === "deploy",
      includeWorkflowRunUrl: input.command !== "cleanup",
      prefix: "doppler run --project _shared --config prd -- ",
    }),
  };
}

function createPreviewLifecycleJob(input: {
  command: string;
  /** Step name for the main command; defaults to the job name. */
  commandStepName?: string;
  /** Doppler-only commands run in the same job after the main command, sharing its runner and setup. */
  dopplerFollowUps?: Array<{ command: string; name: string }>;
  if: string;
  name: string;
  runsOnDoppler?: boolean;
  runsOnForks?: boolean;
}) {
  const commandStepName = input.commandStepName ?? input.name;
  const forkStep: Step = {
    if: "github.event.pull_request.head.repo.fork == true",
    name: `${commandStepName} for forks`,
    env: {
      GITHUB_TOKEN: "${{ secrets.ITERATE_BOT_GITHUB_TOKEN || github.token }}",
      SEMAPHORE_BASE_URL: "https://semaphore.iterate.com",
      WORKFLOW_RUN_URL:
        "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
    },
    run: createPreviewCommand({
      command: input.command,
      includePullRequestBaseSha: input.command === "deploy",
      includePullRequestHeadRefName: input.command === "deploy",
      includePullRequestHeadSha: input.command !== "cleanup",
      includePullRequestIsFork: input.command === "deploy",
      includeSemaphoreBaseUrl: true,
      includeWorkflowRunUrl: true,
    }),
  };

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
      ...(input.runsOnForks ? [forkStep] : []),
      ...(input.runsOnDoppler
        ? [createDopplerStep({ command: input.command, name: commandStepName })]
        : []),
      ...(input.dopplerFollowUps ?? []).map((followUp) => createDopplerStep(followUp)),
      ...(input.command === "deploy" ? createPreviewTestArtifactSteps() : []),
    ],
  } satisfies Workflow["jobs"][string];
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
    preview: createPreviewLifecycleJob({
      command: "deploy",
      commandStepName: "Preview / deploy",
      dopplerFollowUps: [{ command: "test", name: "Preview / e2e" }],
      if: "github.event.action != 'closed'",
      name: "Preview / deploy + e2e",
      runsOnDoppler: true,
      runsOnForks: true,
    }),
    cleanup: createPreviewLifecycleJob({
      command: "cleanup",
      if: "github.event.action == 'closed' && github.event.pull_request.head.repo.fork != true",
      name: "Preview / cleanup",
      runsOnDoppler: true,
    }),
  },
} satisfies Workflow;
