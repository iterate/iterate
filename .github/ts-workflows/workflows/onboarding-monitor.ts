import dedent from "dedent";
import { workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default workflow({
  name: "Onboarding Monitor",
  on: {
    workflow_call: {
      inputs: {
        stage: {
          description:
            "The stage to get doppler secrets from. Must correspond to a Doppler config in the os project (prd, stg, dev, dev_bob etc.).",
          required: true,
          type: "string",
        },
        worker_url: {
          description: "The deployed url to run the onboarding tests against.",
          required: true,
          type: "string",
        },
      },
    },
    schedule: [{ cron: "0 9 * * *" }],
  },
  jobs: {
    "test-onboarding": {
      ...utils.runsOn,
      env: {
        WORKER_URL: "${{ inputs.worker_url }}",
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
          run: "doppler setup --config ${{ inputs.stage }} --project os",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
        },
        {
          name: "Run Onboarding Tests",
          id: "tests",
          uses: "nick-fields/retry@v3",
          with: {
            timeout_minutes: 15,
            max_attempts: 3,
            retry_wait_seconds: 30,
            command: dedent`
              cd apps/os
              doppler run --config \${{ inputs.stage }} -- pnpm vitest run ./backend/e2e-onboarding.test.ts
            `,
          },
          env: {
            WORKER_URL: "${{ inputs.worker_url }}",
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            VITEST_RUN_ONBOARDING_TEST: "true",
          },
        },
        {
          name: "Notify Slack on Failure",
          if: "failure()",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: dedent`
            WEBHOOK_URL=$(doppler secrets get GITHUB_E2E_TEST_FAIL_SLACK_WEBHOOK --plain)

            curl -X POST "$WEBHOOK_URL" -H 'Content-Type: application/json' -d '{
                "text": "🚨 Production Onboarding Tests Failed",
                "blocks": [
                  {
                    "type": "header",
                    "text": {
                      "type": "plain_text",
                      "text": "🚨 Production Onboarding Tests Failed"
                    }
                  },
                  {
                    "type": "section",
                    "fields": [
                      {
                        "type": "mrkdwn",
                        "text": "*Repository:* \${{ github.repository }}"
                      },
                      {
                        "type": "mrkdwn",
                        "text": "*Branch:* \${{ github.ref_name }}"
                      },
                      {
                        "type": "mrkdwn",
                        "text": "*Workflow:* \${{ github.workflow }}"
                      },
                      {
                        "type": "mrkdwn",
                        "text": "*Run Number:* \${{ github.run_number }}"
                      }
                    ]
                  },
                  {
                    "type": "section",
                    "text": {
                      "type": "mrkdwn",
                      "text": "<\${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}|View Workflow Run>"
                    }
                  }
                ]
              }'
          `,
        },
      ],
    },
  },
});
