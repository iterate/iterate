import type { Workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

/**
 * Production rollout strategy (main branch):
 * 1) Deploy iterate.com with current env vars.
 * 2) OS deploys via deploy-os2.yml when apps/os2 changes.
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
    variables: {
      ...utils.runsOnDepotUbuntu,
      steps: [
        {
          name: "Document rollout strategy",
          run: [
            "cat <<'EOF' >> \"$GITHUB_STEP_SUMMARY\"",
            "## Rollout Strategy",
            "1. Deploy iterate.com with current environment variables.",
            "2. OS deploys separately via deploy-os2.yml when apps/os2 changes.",
            "EOF",
          ].join("\n"),
        },
      ],
    },
    deploy: {
      uses: "./.github/workflows/deploy.yml",
      needs: ["variables"],
      secrets: "inherit",
    },
    slack_failure: {
      needs: ["variables", "deploy"],
      if: `always() && contains(needs.*.result, 'failure')`,
      ...utils.runsOnDepotUbuntu,
      env: { NEEDS: "${{ toJson(needs) }}" },
      steps: [
        ...utils.setupRepo,
        await utils.githubScript(import.meta, async function notify_slack_on_failure() {
          const { getSlackClient, slackChannelIds } = await import("../utils/slack.ts");
          const slack = getSlackClient("${{ secrets.SLACK_CI_BOT_TOKEN }}");
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
