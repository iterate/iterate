import { type Workflow } from "@jlarky/gha-ts/workflow-types";
import {
  cloudflarePreviewApps,
  cloudflarePreviewAdditionalTriggerPaths,
  cloudflarePreviewSharedPaths,
} from "../../../scripts/preview/preview.ts";
import * as utils from "../utils/index.ts";

const previewPaths = [
  ...new Set([
    ...cloudflarePreviewSharedPaths,
    ...cloudflarePreviewAdditionalTriggerPaths,
    ...Object.values(cloudflarePreviewApps).flatMap((app) => app.paths),
  ]),
];

// The preview deploy + e2e job lives in Depot CI
// (.depot/workflows/cloudflare-previews.yml): Depot CI picks up jobs in ~7s
// where GitHub Actions runner assignment took 20s-3m39s. This GitHub workflow
// keeps only the PR-close cleanup, which is not latency-sensitive. Keep the
// Depot workflow's paths list in sync with `previewPaths`.
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
      types: ["closed"],
      paths: previewPaths,
    },
  },
  jobs: {
    cleanup: {
      name: "Preview / cleanup",
      ...utils.runsOnDepotUbuntuPreview,
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
            '  --pull-request-number "${{ github.event.pull_request.number }}"',
          ].join("\n"),
        },
      ],
    },
  },
} satisfies Workflow;
