import type { Workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

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
  // todo: uncomment this once depot has unshat the bed
  //   concurrency: {
  //     group: "ci-${{ github.ref }}",
  //     "cancel-in-progress": false,
  //   },
  jobs: {
    /**
     * ${{ env.* }} limitations with reusable workflows:
     *     1. environment variables are not inherited by sub-workflows
     *     2. we can't reference ${{ env.* }} outside of a step
     *
     * This means we need a preliminary job that extracts whatever we need from env,
     * and then pass those values as inputs to the reusable workflow.
     */
    variables: {
      ...utils.runsOnUbuntuLatest,
      steps: [
        {
          id: "get_env",
          name: "Get environment variables",
          // todo: parse the PR number/body/whatever to get a stage like `pr_1234` and any other deployment flags

          run: `echo stage=\${{ inputs.stage || 'prd' }} >> $GITHUB_OUTPUT`,
        },
      ],
      outputs: {
        stage: "${{ steps.get_env.outputs.stage }}",
      },
    },
    "build-snapshot": {
      needs: ["variables"],
      if: "needs.variables.outputs.stage == 'prd'",
      uses: "./.github/workflows/build-snapshot.yml",
      // @ts-expect-error - secrets inherit
      secrets: "inherit",
      with: {
        doppler_config: "prd",
      },
    },
    deploy: {
      uses: "./.github/workflows/deploy.yml",
      needs: ["variables", "build-snapshot"],
      // @ts-expect-error - is jlarky wrong here? https://github.com/JLarky/gha-ts/pull/46
      secrets: "inherit",
      with: {
        stage: "${{ needs.variables.outputs.stage }}",
        daytona_snapshot_name: "${{ needs.build-snapshot.outputs.snapshot_name }}",
      },
    },
    slack_failure: {
      needs: ["variables", "build-snapshot", "deploy"],
      if: `always() && contains(needs.*.result, 'failure')`,
      "runs-on": "ubuntu-latest",
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
