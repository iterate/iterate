import { workflow } from "@jlarky/gha-ts/workflow-types";
import { cloudflarePreviewApps } from "../../../scripts/preview/apps.ts";
import * as utils from "../utils/index.ts";

const previewApps = Object.values(cloudflarePreviewApps).map((app) => ({
  appDisplayName: app.displayName,
  appSlug: app.slug,
}));

const previewPaths = [...new Set(Object.values(cloudflarePreviewApps).flatMap((app) => app.paths))];

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
      strategy: {
        "fail-fast": false,
        "max-parallel": 1,
        matrix: {
          include: previewApps,
        },
      },
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
          name: "Sync preview for forks",
          env: {
            APP: "${{ matrix.appSlug }}",
            GITHUB_TOKEN: "${{ secrets.ITERATE_BOT_GITHUB_TOKEN || github.token }}",
            SEMAPHORE_BASE_URL: "https://semaphore.iterate.com",
            WORKFLOW_RUN_URL:
              "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
          },
          run: [
            "set -euo pipefail",
            "pnpm preview sync \\",
            '  --app "$APP" \\',
            '  --github-token "$GITHUB_TOKEN" \\',
            '  --pull-request-head-ref-name "${{ github.event.pull_request.head.ref }}" \\',
            '  --pull-request-head-sha "${{ github.event.pull_request.head.sha }}" \\',
            '  --pull-request-base-sha "${{ github.event.pull_request.base.sha }}" \\',
            '  --pull-request-number "${{ github.event.pull_request.number }}" \\',
            '  --repository-full-name "${{ github.repository }}" \\',
            '  --workflow-run-url "$WORKFLOW_RUN_URL" \\',
            "  --is-fork \"${{ github.event.pull_request.head.repo.fork && 'true' || 'false' }}\" \\",
            '  --semaphore-base-url "$SEMAPHORE_BASE_URL"',
          ].join("\n"),
        },
        {
          if: "github.event.action != 'closed' && github.event.pull_request.head.repo.fork != true",
          name: "Sync preview",
          env: {
            APP: "${{ matrix.appSlug }}",
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            GITHUB_TOKEN: "${{ secrets.ITERATE_BOT_GITHUB_TOKEN || github.token }}",
            WORKFLOW_RUN_URL:
              "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
          },
          run: [
            "set -euo pipefail",
            "doppler run --project os --config prd -- pnpm preview sync \\",
            '  --app "$APP" \\',
            '  --github-token "$GITHUB_TOKEN" \\',
            '  --pull-request-head-ref-name "${{ github.event.pull_request.head.ref }}" \\',
            '  --pull-request-head-sha "${{ github.event.pull_request.head.sha }}" \\',
            '  --pull-request-base-sha "${{ github.event.pull_request.base.sha }}" \\',
            '  --pull-request-number "${{ github.event.pull_request.number }}" \\',
            '  --repository-full-name "${{ github.repository }}" \\',
            '  --workflow-run-url "$WORKFLOW_RUN_URL" \\',
            "  --is-fork \"${{ github.event.pull_request.head.repo.fork && 'true' || 'false' }}\"",
          ].join("\n"),
        },
        {
          if: "github.event.action == 'closed' && github.event.pull_request.head.repo.fork != true",
          name: "Cleanup preview",
          env: {
            APP: "${{ matrix.appSlug }}",
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            GITHUB_TOKEN: "${{ secrets.ITERATE_BOT_GITHUB_TOKEN || github.token }}",
          },
          run: [
            "set -euo pipefail",
            "doppler run --project os --config prd -- pnpm preview cleanup \\",
            '  --app "$APP" \\',
            '  --github-token "$GITHUB_TOKEN" \\',
            '  --pull-request-number "${{ github.event.pull_request.number }}" \\',
            '  --repository-full-name "${{ github.repository }}"',
          ].join("\n"),
        },
      ],
    },
  },
});
