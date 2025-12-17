import { uses, workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default workflow({
  name: "e2e tests",
  on: {
    push: {
      branches: ["**/*e2e*"],
    },
    workflow_call: {
      inputs: {
        stage: {
          description:
            "The stage to get doppler secrets from. Must correspond to a Doppler config in the os project (prd, stg, dev, dev_bob etc.).",
          required: true,
          type: "string",
        },
        worker_url: {
          description: "The deployed url to run the e2e tests against.",
          required: true,
          type: "string",
        },
      },
    },
  },
  jobs: {
    run: {
      ...utils.runsOn,
      env: {
        WORKER_URL: "${{ inputs.worker_url || 'http://localhost:5173' }}",
      },
      steps: [
        {
          name: "Checkout code",
          uses: "actions/checkout@v4",
        },
        {
          name: "Setup pnpm",
          uses: "pnpm/action-setup@v4",
        },
        {
          name: "Setup Node",
          uses: "actions/setup-node@v4",
          with: {
            "node-version": 24,
            cache: "pnpm",
          },
        },
        {
          name: "Install dependencies",
          run: "pnpm install",
        },
        {
          name: "Install Doppler CLI",
          uses: "dopplerhq/cli-action@v2",
        },
        {
          name: "Setup Doppler",
          run: "doppler setup --config ${{ inputs.stage || 'dev' }} --project os",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
        },
        {
          if: "!inputs.worker_url",
          ...utils.runPreviewServer,
        },
        {
          name: "Install Playwright browsers",
          "working-directory": "apps/os",
          run: "pnpm exec playwright install && pnpm exec playwright install-deps",
        },
        {
          name: "Run E2E Tests",
          id: "tests",
          uses: "nick-fields/retry@v3",
          with: {
            timeout_minutes: 15,
            max_attempts: 3,
            retry_wait_seconds: 30,
            command:
              "doppler run --config ${{ inputs.stage }} -- pnpm os e2e --reporter default --reporter html",
          },
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
        },
        {
          name: "upload e2e logs",
          if: "failure()",
          ...uses("actions/upload-artifact@v4", {
            name: "e2e-logs",
            path: "apps/os/e2e-ignoreme",
          }),
        },
      ],
    },
  },
});
