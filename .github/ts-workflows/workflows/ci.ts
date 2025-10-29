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
      branches: ["main", "mmkal/25/10/28/runonboardingagainststaging"],
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
            echo \"stage=\${{ inputs.stage || 'stg' }}\" >> $GITHUB_OUTPUT
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
    onboarding_monitor: {
      uses: "./.github/workflows/onboarding-monitor.yml",
      // @ts-expect-error - is jlarky wrong here? https://github.com/JLarky/gha-ts/pull/46
      secrets: "inherit",
      needs: ["variables", "deploy"],
      with: {
        worker_url: "${{ needs.deploy.outputs.worker_url || 'some_garbage' }}",
        stage: "${{ needs.variables.outputs.stage }}",
      },
    },
    // slack_failure: {
    //   needs: ["variables", "build", "content", "api"],
    //   if: `always() && needs.variables.outputs.branch == 'production' && contains(needs.*.result, 'failure')`,
    //   "runs-on": "ubuntu-latest",
    //   steps: helpers.withSlackMessage({
    //     channel: helpers.slackChannels.tech,
    //     messages: { initial: `:birdfall: Production CI failed!` },
    //     steps: [],
    //   }),
    // },
  },
} satisfies Workflow;
