import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

/**
 * Agent Response Time — measures end-to-end latency through the webchat flow.
 *
 * Can target:
 *   - A deployed environment (stg/prd) with Daytona machines
 *   - A local dev server with local-docker machines
 *
 * Triggered manually via workflow_dispatch or called by other workflows.
 */
export default workflow({
  name: "Agent Response Time",
  permissions: {
    contents: "read",
    "id-token": "write",
  },
  on: {
    workflow_dispatch: {
      inputs: {
        app_url: {
          description:
            "OS base URL to test against (e.g. https://stg.iterate.com). Defaults to staging.",
          required: false,
          type: "string",
          default: "",
        },
        machine_type: {
          description: "Machine provider to use: daytona or local-docker",
          required: false,
          type: "string",
          default: "daytona",
        },
        doppler_config: {
          description: "Doppler config to use (dev, stg, prd)",
          required: false,
          type: "string",
          default: "stg",
        },
      },
    },
    workflow_call: {
      inputs: {
        app_url: {
          description: "OS base URL to test against",
          required: false,
          type: "string",
          default: "",
        },
        machine_type: {
          description: "Machine provider: daytona or local-docker",
          required: false,
          type: "string",
          default: "daytona",
        },
        doppler_config: {
          description: "Doppler config to use",
          required: false,
          type: "string",
          default: "stg",
        },
      },
      outputs: {
        perf_json: {
          description: "JSON blob with timing results",
          value: "${{ jobs.agent-response-time.outputs.perf_json }}",
        },
      },
    },
  },
  jobs: {
    "agent-response-time": {
      ...utils.runsOnDepotUbuntuForContainerThings,
      outputs: {
        perf_json: "${{ steps.test.outputs.perf_json }}",
      },
      steps: [
        {
          name: "Checkout code",
          ...uses("actions/checkout@v4"),
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
        ...utils.setupDoppler({
          config: `\${{ inputs.doppler_config || 'stg' }}`,
        }),
        {
          name: "Install Playwright browsers",
          run: "pnpm exec playwright install --with-deps chromium",
        },
        {
          id: "resolve-url",
          name: "Resolve APP_URL",
          run: [
            'APP_URL="${{ inputs.app_url }}"',
            'if [ -z "$APP_URL" ]; then',
            "  # Default to VITE_PUBLIC_URL from Doppler (staging)",
            '  APP_URL="$(doppler secrets get VITE_PUBLIC_URL --plain)"',
            "fi",
            'echo "app_url=$APP_URL" >> "$GITHUB_OUTPUT"',
            'echo "Testing against: $APP_URL"',
          ].join("\n"),
        },
        {
          id: "test",
          name: "Run Agent Response Time Test",
          env: {
            AGENT_RESPONSE_TIME_TEST: "1",
            APP_URL: "${{ steps.resolve-url.outputs.app_url }}",
            MACHINE_TYPE: "${{ inputs.machine_type || 'daytona' }}",
          },
          run: [
            "set -o pipefail",
            "mkdir -p test-results",
            // Run only the agent-response-time spec
            "pnpm spec -- spec/agent-response-time.spec.ts 2>&1 | tee test-results/agent-response-time.txt",
            // Extract the JSON timing blob for workflow outputs
            "PERF_JSON=$(grep 'AGENT_PERF_JSON=' test-results/agent-response-time.txt | sed 's/AGENT_PERF_JSON=//' || echo '{}')",
            'echo "perf_json=$PERF_JSON" >> "$GITHUB_OUTPUT"',
          ].join("\n"),
        },
        {
          name: "Upload test results",
          if: "always()",
          ...uses("actions/upload-artifact@v4", {
            name: "agent-response-time-results",
            path: "test-results",
            "retention-days": 30,
          }),
        },
      ],
    },
  },
});
