import type { Workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

/**
 * Production rollout on push to main:
 * 1) Deploy apps/iterate-com.
 * 2) OS/semaphore/etc deploy via their own deploy-*.yml when their paths change.
 * Slack-notifies #error-pulse if the deploy fails.
 */
export default {
  name: "CI",
  permissions: {
    contents: "read",
    deployments: "write",
  },
  on: {
    push: {
      branches: ["main"],
    },
    workflow_dispatch: {},
  },
  jobs: {
    "deploy-iterate-com": {
      ...utils.runsOnDepotImage,
      steps: [
        ...utils.setupFromImage(),
        ...utils.setupDopplerBaked({ config: "prd", project: "iterate-com" }),
        {
          name: "Deploy apps/iterate-com",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: "pnpm run deploy",
          "working-directory": "apps/iterate-com",
        },
      ],
    },
    slack_failure: {
      needs: ["deploy-iterate-com"],
      if: `always() && contains(needs.*.result, 'failure')`,
      ...utils.runsOnDepotImage,
      // DOPPLER_TOKEN lets slack.ts resolve SLACK_CI_BOT_TOKEN from Doppler.
      env: { NEEDS: "${{ toJson(needs) }}", DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}" },
      steps: [
        ...utils.setupFromImage(),
        await utils.githubScript(import.meta, async function notify_slack_on_failure() {
          const { getSlackClient, slackChannelIds } = await import("../utils/slack.ts");
          const slack = getSlackClient();
          const needs = JSON.parse(process.env.NEEDS!);
          const failedJobs = Object.entries(needs)
            .filter(([_, { result }]: [string, any]) => result === "failure")
            .map(([name]) => name);
          let message = `🚨 ${failedJobs.join(", ")} failed on \${{ github.ref_name }}.`;
          message +=
            " <${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}|View Workflow Run>";
          message += "\n@iterate please investigate";
          await slack.chat.postMessage({
            channel: slackChannelIds["#error-pulse"],
            text: message,
          });
        }),
      ],
    },
  },
} satisfies Workflow;
