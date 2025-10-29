import dedent from "dedent";
import type { Workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default {
  name: "CI",
  on: {
    push: {
      branches: ["main", "mmkal/25/10/28/runonboardingagainststaging"],
    },
    // pull_request: {
    //   types: ["opened", "synchronize", "reopened"],
    // },
    workflow_dispatch: {
      inputs: {
        stage: {
          description:
            "The stage to deploy to. Must correspond to a Doppler config in the os project (prd, stg, dev, dev_bob etc.).",
          required: true,
          type: "string",
        },
      },
    },
  },
  concurrency: {
    group: "ci-${{ github.ref }}",
    "cancel-in-progress": true,
  },
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
      ...utils.runsOn,
      steps: [
        {
          id: "get_env",
          name: "Get environment variables",
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
      // @ts-expect-error - is jlarky wrong here?
      secrets: "inherit",
      with: {
        stage: "${{ needs.variables.outputs.stage }}",
      },
    },
    onboarding_monitor: {
      if: "needs.variables.outputs.stage == 'prd' || needs.variables.outputs.stage == 'stg'",
      uses: "./.github/workflows/onboarding-monitor.yml",
      // @ts-expect-error - is jlarky wrong here?
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
