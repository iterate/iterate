import type { Workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

/**
 * Production rollout strategy (main branch):
 * 1) Deploy OS worker fast with current env vars (deploy-os-early)
 * 2) Build new sandbox image
 * 3) Run Fly sandbox tests against the new image
 * 4) Promote FLY_DEFAULT_IMAGE in Doppler + deploy OS worker again
 *
 * This keeps the worker rollout fast while still gating env-var promotion
 * and final deploy on post-build sandbox verification.
 */
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
        {
          name: "Document rollout strategy",
          run: [
            "cat <<'EOF' >> \"$GITHUB_STEP_SUMMARY\"",
            "## Rollout Strategy",
            "1. Deploy OS worker quickly with current environment variables.",
            "2. Build new sandbox image.",
            "3. Run Fly sandbox tests against the new image.",
            "4. If tests pass, update Doppler FLY_DEFAULT_IMAGE and deploy OS worker again.",
            "EOF",
          ].join("\n"),
        },
      ],
      outputs: {
        stage: "${{ steps.get_env.outputs.stage }}",
      },
    },
    "deploy-os-early": {
      uses: "./.github/workflows/deploy.yml",
      needs: ["variables"],
      if: "needs.variables.outputs.stage == 'prd'",
      // @ts-expect-error - is jlarky wrong here? https://github.com/JLarky/gha-ts/pull/46
      secrets: "inherit",
      with: {
        stage: "${{ needs.variables.outputs.stage }}",
        deploy_iterate_com: false,
      },
    },
    "build-sandbox-image": {
      uses: "./.github/workflows/build-sandbox-image.yml",
      needs: ["variables", "deploy-os-early"],
      if: "needs.variables.outputs.stage == 'prd'",
      // @ts-expect-error - reusable workflow supports secrets: inherit
      secrets: "inherit",
      with: {
        doppler_config: "prd",
        docker_platform: "linux/amd64",
        skip_load: false,
        update_doppler: false,
      },
    },
    "test-sandbox-fly": {
      needs: ["variables", "build-sandbox-image"],
      if: "needs.variables.outputs.stage == 'prd'",
      uses: "./.github/workflows/sandbox-test-fly.yml",
      // @ts-expect-error - reusable workflow supports secrets: inherit
      secrets: "inherit",
      with: {
        doppler_config: "prd",
        fly_image_tag: "${{ needs.build-sandbox-image.outputs.fly_image_tag }}",
      },
    },
    "promote-fly-default-image": {
      needs: ["variables", "build-sandbox-image", "test-sandbox-fly"],
      if: "needs.variables.outputs.stage == 'prd'",
      ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
      steps: [
        ...utils.setupDoppler({ config: "prd" }),
        {
          name: "Update Doppler FLY_DEFAULT_IMAGE",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            FLY_IMAGE_TAG: "${{ needs.build-sandbox-image.outputs.fly_image_tag }}",
          },
          run: [
            "set -euo pipefail",
            'echo "Promoting FLY_DEFAULT_IMAGE=${FLY_IMAGE_TAG} to dev/stg/prd"',
            "for cfg in dev stg prd; do",
            '  doppler secrets set FLY_DEFAULT_IMAGE="${FLY_IMAGE_TAG}" --project os --config "${cfg}"',
            "done",
          ].join("\n"),
        },
      ],
    },
    deploy: {
      uses: "./.github/workflows/deploy.yml",
      needs: [
        "variables",
        "deploy-os-early",
        "build-sandbox-image",
        "test-sandbox-fly",
        "promote-fly-default-image",
      ],
      if: "needs.variables.outputs.stage == 'prd'",
      // @ts-expect-error - is jlarky wrong here? https://github.com/JLarky/gha-ts/pull/46
      secrets: "inherit",
      with: {
        stage: "${{ needs.variables.outputs.stage }}",
      },
    },
    slack_failure: {
      needs: [
        "variables",
        "deploy-os-early",
        "build-sandbox-image",
        "test-sandbox-fly",
        "promote-fly-default-image",
        "deploy",
      ],
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
