import type { Workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default {
  name: "CI",
  permissions: {
    contents: "read",
    deployments: "write",
    "id-token": "write", // Required for Depot OIDC auth in called workflows
  },
  on: {
    push: {
      branches: ["main"],
    },
    workflow_dispatch: {
      inputs: {
        stage: {
          description:
            "The stage to deploy to. Must correspond to a Doppler config in the os project (prd, stg, dev, dev_bob etc.).",
          required: false,
          type: "string",
        },
      },
    },
  },
  jobs: {
    variables: {
      ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
      steps: [
        {
          id: "get_env",
          name: "Get environment variables",
          run: `echo stage=\${{ inputs.stage || 'prd' }} >> $GITHUB_OUTPUT`,
        },
      ],
      outputs: {
        stage: "${{ steps.get_env.outputs.stage }}",
      },
    },
    // TEMP: skip Daytona snapshot build to keep deploys fast.
    // "build-daytona-snapshot": {
    //   needs: ["variables"],
    //   if: "needs.variables.outputs.stage == 'prd'",
    //   uses: "./.github/workflows/build-daytona-snapshot.yml",
    //   // @ts-expect-error - secrets inherit
    //   secrets: "inherit",
    //   with: {
    //     doppler_config: "prd",
    //   },
    // },
    deploy: {
      uses: "./.github/workflows/deploy.yml",
      needs: ["variables"],
      if: "needs.variables.outputs.stage == 'prd'",
      // @ts-expect-error - is jlarky wrong here? https://github.com/JLarky/gha-ts/pull/46
      secrets: "inherit",
      with: {
        stage: "${{ needs.variables.outputs.stage }}",
        // TEMP: use preconfigured snapshot; do not build new snapshot in CI.
        daytona_snapshot_name: "${{ vars.DAYTONA_SNAPSHOT_NAME || '' }}",
      },
    },
    slack_failure: {
      needs: ["variables", "deploy"],
      if: `always() && contains(needs.*.result, 'failure')`,
      ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
      env: { NEEDS: "${{ toJson(needs) }}" },
      steps: [
        ...utils.setupRepo,
        utils.githubScript(import.meta, async function notify_slack_on_failure() {
          const { getSlackClient, slackChannelIds } = await import("../utils/slack.ts");
          const slack = getSlackClient("${{ secrets.SLACK_CI_BOT_TOKEN }}");
          const needs = JSON.parse(process.env.NEEDS!);
          const failedJobs = Object.entries(needs)
            .filter(([_, { result }]: [string, any]) => result === "failure")
            .map(([name]) => name);
          const outputs = needs.variables?.outputs as Record<string, string>;
          const outputsString = new URLSearchParams(outputs).toString().replaceAll("&", ", ");
          let message = `🚨 ${failedJobs.join(", ")} failed on \${{ github.ref_name }}. ${outputsString}.`;
          message +=
            " <${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}|View Workflow Run>";
          await slack.chat.postMessage({
            channel: slackChannelIds["#error-pulse"],
            text: message,
          });
        }),
      ],
    },
  },
} satisfies Workflow;
