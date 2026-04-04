import { workflow } from "@jlarky/gha-ts/workflow-types";
import { cloudflarePreviewApps } from "../../../scripts/preview/apps.ts";
import * as utils from "../utils/index.ts";

const previewCleanupApps = Object.values(cloudflarePreviewApps).map((app) => ({
  appDisplayName: app.displayName,
  appSlug: app.slug,
}));

export default workflow({
  name: "Cleanup Cloudflare Previews",
  permissions: {
    contents: "read",
    issues: "write",
    "pull-requests": "write",
  },
  on: {
    pull_request: {
      types: ["closed"],
    },
  },
  jobs: {
    cleanup: {
      strategy: {
        "fail-fast": false,
        "max-parallel": 1,
        matrix: {
          include: previewCleanupApps,
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
          if: "github.event.pull_request.head.repo.fork != true",
          name: "Cleanup preview from repo preview router",
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
