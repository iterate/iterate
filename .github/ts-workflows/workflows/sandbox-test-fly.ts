import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default workflow({
  name: "Sandbox Fly Tests",
  permissions: {
    contents: "read",
    "id-token": "write",
  },
  on: {
    workflow_call: {
      inputs: {
        ref: {
          description: "Git ref to test (branch, tag, or SHA). Uses caller ref if empty.",
          required: false,
          type: "string",
          default: "",
        },
        fly_image_tag: {
          description: "Fly image tag to test (e.g. registry.fly.io/iterate-sandbox:sha-abc1234)",
          required: true,
          type: "string",
        },
        doppler_config: {
          description: "Doppler config (dev, stg, prd)",
          required: false,
          type: "string",
          default: "dev",
        },
      },
    },
    workflow_dispatch: {
      inputs: {
        ref: {
          description: "Git ref to test (branch, tag, or SHA). Leave empty for current branch.",
          required: false,
          type: "string",
          default: "",
        },
        fly_image_tag: {
          description: "Fly image tag to test (e.g. registry.fly.io/iterate-sandbox:sha-abc1234)",
          required: true,
          type: "string",
        },
        doppler_config: {
          description: "Doppler config (dev, stg, prd)",
          required: false,
          type: "string",
          default: "dev",
        },
      },
    },
  },
  jobs: {
    "test-sandbox-fly": {
      ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
      steps: [
        {
          name: "Checkout code",
          ...uses("actions/checkout@v4", {
            ref: "${{ inputs.ref || github.event.pull_request.head.sha || github.sha }}",
          }),
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
        ...utils.setupDoppler({ config: "${{ inputs.doppler_config }}" }),
        {
          name: "Run Fly sandbox tests",
          uses: "nick-fields/retry@v3",
          env: {
            RUN_SANDBOX_TESTS: "true",
            SANDBOX_TEST_PROVIDER: "fly",
            SANDBOX_TEST_SNAPSHOT_ID: "${{ inputs.fly_image_tag }}",
            FLY_DEFAULT_IMAGE: "${{ inputs.fly_image_tag }}",
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          with: {
            timeout_minutes: 15,
            max_attempts: 3,
            retry_wait_seconds: 30,
            command:
              "doppler run -- pnpm sandbox test test/provider-base-image.test.ts --maxWorkers=1",
          },
        },
        {
          name: "Upload Fly test results",
          if: "failure()",
          ...uses("actions/upload-artifact@v4", {
            name: "fly-provider-test-logs",
            path: "sandbox/test-results",
            "retention-days": 7,
          }),
        },
        {
          name: "Cleanup leftover Fly test machines",
          if: "always()",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: "doppler run -- pnpm sandbox fly:cleanup -- 0s delete --prefix test-base-image-test --all",
        },
      ],
    },
  },
});
