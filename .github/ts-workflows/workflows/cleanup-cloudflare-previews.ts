import { workflow } from "@jlarky/gha-ts/workflow-types";
import { cloudflareApps } from "../utils/cloudflare-apps.ts";
import * as utils from "../utils/index.ts";

const previewCleanupApps = Object.values(cloudflareApps).map((app) => ({
  appDisplayName: app.displayName,
  appPath: app.appPath,
  appSlug: app.slug,
}));

export default workflow({
  name: "Cleanup Cloudflare Previews",
  on: {
    pull_request: {
      types: ["closed"],
    },
  },
  jobs: {
    cleanup: {
      strategy: {
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
          name: "Setup Doppler for Semaphore",
          run: "doppler setup --config prd --project semaphore",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
        },
        {
          if: "github.event.pull_request.head.repo.fork != true",
          name: "Expose Semaphore API token",
          run: 'echo "APP_CONFIG_SHARED_API_SECRET=$(doppler secrets get APP_CONFIG_SHARED_API_SECRET --plain)" >> $GITHUB_ENV',
        },
        {
          name: "Cleanup preview from app-local script",
          "working-directory": "${{ matrix.appPath }}",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            GITHUB_PR_NUMBER: "${{ github.event.pull_request.number }}",
            GITHUB_REPOSITORY: "${{ github.repository }}",
            GITHUB_TOKEN: "${{ github.token }}",
          },
          run: "pnpm iterate --local-router ./scripts/router.ts local-router preview-cleanup-pr",
        },
      ],
    },
  },
});
