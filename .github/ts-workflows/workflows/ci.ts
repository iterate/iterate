import dedent from "dedent";
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
      branches: ["main", "mmkal/25/10/29/slackclientinworkflows"],
    },
    workflow_dispatch: {
      inputs: {
        stage: {
          description:
            "The stage to deploy to. Must correspond to a Doppler config in the os project (prd, stg, dev, dev_bob etc.).",
          default: "prd",
          required: true,
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
          run: dedent`
            echo stage=\${{ inputs.stage || 'stg' }} >> $GITHUB_OUTPUT
          `,
        },
      ],
      outputs: {
        stage: "${{ steps.get_env.outputs.stage }}",
      },
    },
    deploy: {
      uses: "./.github/workflows/deploy.yml",
      needs: ["variables"],
      // @ts-expect-error - is jlarky wrong here? https://github.com/JLarky/gha-ts/pull/46
      secrets: "inherit",
      with: {
        stage: "${{ needs.variables.outputs.stage }}",
      },
    },
    e2e: {
      if: "needs.variables.outputs.stage == 'prd' || needs.variables.outputs.stage == 'stg'",
      uses: "./.github/workflows/e2e.yml",
      // @ts-expect-error - is jlarky wrong here? https://github.com/JLarky/gha-ts/pull/46
      secrets: "inherit",
      needs: ["variables", "deploy"],
      with: {
        worker_url: "${{ needs.deploy.outputs.worker_url || 'some_garbage' }}",
        stage: "${{ needs.variables.outputs.stage }}",
      },
    },
    slack_failure: {
      needs: ["variables", "deploy", "e2e"],
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
          await slack.chat.postMessage({
            channel: slackChannelIds["#error-pulse"],
            blocks: [
              {
                type: "header",
                text: {
                  type: "plain_text",
                  text: `🚨 CI Failed: ${failedJobs.join(", ")}. Variables: ${new URLSearchParams(needs.variables?.outputs)}`,
                },
              },
              {
                type: "section",
                fields: [
                  { type: "mrkdwn", text: "*Repository:* ${{ github.repository }}" },
                  { type: "mrkdwn", text: "*Branch:* ${{ github.ref_name }}" },
                  { type: "mrkdwn", text: "*Workflow:* ${{ github.workflow }}" },
                  { type: "mrkdwn", text: "*Run Number:* ${{ github.run_number }}" },
                ],
              },
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: "<${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}|View Workflow Run>",
                },
              },
            ],
          });
        }),
      ],
    },
  },
} satisfies Workflow;
