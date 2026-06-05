import { workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

const workerName = "stream-staging-area-pr-${{ github.event.pull_request.number }}";

export default workflow({
  name: "Streams E2E",
  on: {
    pull_request: {
      types: ["opened", "reopened", "synchronize", "closed"],
      paths: [
        ".github/ts-workflows/workflows/streams-e2e.ts",
        ".github/workflows/streams-e2e.yml",
        "packages/streams/**",
      ],
    },
  },
  permissions: {
    contents: "read",
  },
  concurrency: {
    group: "streams-e2e-pr-${{ github.event.pull_request.number }}",
    "cancel-in-progress": false,
  },
  jobs: {
    "streams-e2e": {
      if: "github.event.action != 'closed'",
      ...utils.runsOnDepotUbuntu,
      env: {
        DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
        WORKER_NAME: workerName,
        WORKER_URL: `https://${workerName}.iterate-dev-preview.workers.dev`,
        STREAM_STAGING_E2E: "true",
      },
      steps: [
        ...utils.getSetupRepo({ ref: "${{ github.event.pull_request.head.sha }}" }),
        utils.installDopplerCli,
        {
          name: "Destroy existing streams worker",
          "working-directory": "packages/streams/example-app",
          run: 'doppler run --project _shared --config prd -- pnpm exec wrangler delete "$WORKER_NAME" --force || true',
        },
        {
          name: "Build streams example app",
          "working-directory": "packages/streams/example-app",
          run: "pnpm build",
        },
        {
          name: "Deploy streams worker",
          "working-directory": "packages/streams/example-app",
          run: 'doppler run --project _shared --config prd -- pnpm exec wrangler deploy --name "$WORKER_NAME"',
        },
        {
          name: "Run streams Vitest e2e",
          run: "pnpm --dir packages/streams/example-app vitest",
        },
        {
          name: "Install Playwright browser",
          run: "pnpm --dir packages/streams/example-app exec playwright install --with-deps chromium",
        },
        {
          name: "Run streams Playwright e2e",
          run: "pnpm --dir packages/streams/example-app playwright",
        },
      ],
    },
    cleanup: {
      if: "github.event.action == 'closed'",
      ...utils.runsOnDepotUbuntu,
      env: {
        DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
        WORKER_NAME: workerName,
      },
      steps: [
        ...utils.setupRepo,
        utils.installDopplerCli,
        {
          name: "Destroy streams worker",
          "working-directory": "packages/streams/example-app",
          run: 'doppler run --project _shared --config prd -- pnpm exec wrangler delete "$WORKER_NAME" --force || true',
        },
      ],
    },
  },
});
