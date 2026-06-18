import { uses, type Workflow } from "@jlarky/gha-ts/workflow-types";
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
    preview: {
      if: "github.event.action != 'closed'",
      name: "Preview / deploy + e2e",
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
        {
          if: "github.event.pull_request.head.repo.fork == true",
          name: "Preview / deploy for forks",
          env: {
            GITHUB_TOKEN: "${{ secrets.ITERATE_BOT_GITHUB_TOKEN || github.token }}",
            SEMAPHORE_BASE_URL: "https://semaphore.iterate.com",
            WORKFLOW_RUN_URL:
              "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
          },
          run: [
            "set -euo pipefail",
            "pnpm preview deploy \\",
            '  --github-token "$GITHUB_TOKEN" \\',
            '  --pull-request-head-ref-name "${{ github.event.pull_request.head.ref }}" \\',
            '  --pull-request-head-sha "${{ github.event.pull_request.head.sha }}" \\',
            '  --pull-request-base-sha "${{ github.event.pull_request.base.sha }}" \\',
            '  --pull-request-number "${{ github.event.pull_request.number }}" \\',
            '  --repository-full-name "${{ github.repository }}" \\',
            "  --is-fork \"${{ github.event.pull_request.head.repo.fork && 'true' || 'false' }}\" \\",
            '  --workflow-run-url "$WORKFLOW_RUN_URL" \\',
            '  --semaphore-base-url "$SEMAPHORE_BASE_URL"',
          ].join("\n"),
        },
        {
          if: "github.event.pull_request.head.repo.fork != true",
          name: "Preview / deploy",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            GITHUB_TOKEN: "${{ secrets.ITERATE_BOT_GITHUB_TOKEN || github.token }}",
            WORKFLOW_RUN_URL:
              "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
          },
          run: [
            "set -euo pipefail",
            "doppler run --project _shared --config prd -- pnpm preview deploy \\",
            '  --github-token "$GITHUB_TOKEN" \\',
            '  --pull-request-head-ref-name "${{ github.event.pull_request.head.ref }}" \\',
            '  --pull-request-head-sha "${{ github.event.pull_request.head.sha }}" \\',
            '  --pull-request-base-sha "${{ github.event.pull_request.base.sha }}" \\',
            '  --pull-request-number "${{ github.event.pull_request.number }}" \\',
            '  --repository-full-name "${{ github.repository }}" \\',
            "  --is-fork \"${{ github.event.pull_request.head.repo.fork && 'true' || 'false' }}\" \\",
            '  --workflow-run-url "$WORKFLOW_RUN_URL"',
          ].join("\n"),
        },
        {
          if: "github.event.pull_request.head.repo.fork != true",
          name: "Preview / e2e",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            GITHUB_TOKEN: "${{ secrets.ITERATE_BOT_GITHUB_TOKEN || github.token }}",
            WORKFLOW_RUN_URL:
              "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
          },
          run: [
            "set -euo pipefail",
            "doppler run --project _shared --config prd -- pnpm preview test \\",
            '  --github-token "$GITHUB_TOKEN" \\',
            '  --pull-request-head-sha "${{ github.event.pull_request.head.sha }}" \\',
            '  --pull-request-number "${{ github.event.pull_request.number }}" \\',
            '  --repository-full-name "${{ github.repository }}" \\',
            '  --workflow-run-url "$WORKFLOW_RUN_URL"',
          ].join("\n"),
        },
        ...Object.values(cloudflarePreviewApps).flatMap((app) =>
          app.previewTestArtifacts
            ? [
                {
                  name: `Upload ${app.displayName} preview test artifacts`,
                  if: "always() && github.event.pull_request.head.repo.fork != true",
                  ...uses("actions/upload-artifact@v4", {
                    name: `preview-${app.slug}-test-artifacts`,
                    path: app.previewTestArtifacts.join("\n"),
                    "if-no-files-found": "ignore",
                  }),
                },
              ]
            : [],
        ),
      ],
    },
    cleanup: {
      if: "github.event.action == 'closed' && github.event.pull_request.head.repo.fork != true",
      name: "Preview / cleanup",
      ...utils.runsOnDepotUbuntu64,
      concurrency: {
        group: `cloudflare-preview-lifecycle-\${{ github.event.pull_request.number }}`,
        "cancel-in-progress": false,
      },
      steps: [
        ...utils.getSetupRepo({
          ref: "${{ github.event.pull_request.head.sha || github.sha }}",
        }),
        utils.installDopplerCli,
        {
          name: "Preview / cleanup",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            GITHUB_TOKEN: "${{ secrets.ITERATE_BOT_GITHUB_TOKEN || github.token }}",
          },
          run: [
            "set -euo pipefail",
            "doppler run --project _shared --config prd -- pnpm preview cleanup \\",
            '  --github-token "$GITHUB_TOKEN" \\',
            '  --pull-request-number "${{ github.event.pull_request.number }}" \\',
            '  --repository-full-name "${{ github.repository }}"',
          ].join("\n"),
        },
      ],
    },
  },
} satisfies Workflow;
