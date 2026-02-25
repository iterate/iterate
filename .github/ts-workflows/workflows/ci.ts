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
 *
 * Slack notifications are posted to #building as a thread — one message
 * per major CI milestone so the team can follow deployment progress.
 */

const isPrd = "needs.variables.outputs.stage == 'prd'";

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
    "slack-ci-start": {
      needs: ["variables"],
      if: isPrd,
      ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
      outputs: {
        thread_ts: "${{ steps.slack_ci_start.outputs.result }}",
      },
      steps: [
        ...utils.setupRepo,
        await utils.githubScript(
          import.meta,
          { "result-encoding": "string" },
          async function slack_ci_start() {
            const { getSlackClient, slackChannelIds } = await import("../utils/slack.ts");
            const slack = getSlackClient("${{ secrets.SLACK_CI_BOT_TOKEN }}");
            const sha = "${{ github.sha }}".slice(0, 7);
            const runUrl =
              "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}";
            const result = await slack.chat.postMessage({
              channel: slackChannelIds["#building"],
              text: `🚀 CI started for \`${sha}\` — <${runUrl}|view run>\n_deploying OS worker (early) →_`,
            });
            return result.ts;
          },
        ),
      ],
    },
    "deploy-os-early": {
      uses: "./.github/workflows/deploy.yml",
      needs: ["variables", "slack-ci-start"],
      if: isPrd,
      // @ts-expect-error - is jlarky wrong here? https://github.com/JLarky/gha-ts/pull/46
      secrets: "inherit",
      with: {
        stage: "${{ needs.variables.outputs.stage }}",
        deploy_iterate_com: false,
      },
    },
    "notify-deploy-os-early": {
      needs: ["variables", "slack-ci-start", "deploy-os-early"],
      if: `${isPrd} && !cancelled()`,
      ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
      steps: [
        ...utils.setupRepo,
        await utils.githubScript(import.meta, async function notify_deploy_os_early() {
          const { getSlackClient, slackChannelIds } = await import("../utils/slack.ts");
          const slack = getSlackClient("${{ secrets.SLACK_CI_BOT_TOKEN }}");
          const failed = "${{ needs.deploy-os-early.result }}" === "failure";
          const emoji = failed ? "❌" : "✅";
          const suffix = failed ? "" : "\n_building sandbox image →_";
          await slack.chat.postMessage({
            channel: slackChannelIds["#building"],
            thread_ts: "${{ needs.slack-ci-start.outputs.thread_ts }}",
            text: `${emoji} OS worker deployed (early, old image)${suffix}`,
          });
        }),
      ],
    },
    "build-sandbox-image": {
      uses: "./.github/workflows/build-sandbox-image.yml",
      needs: ["variables", "deploy-os-early"],
      if: isPrd,
      // @ts-expect-error - reusable workflow supports secrets: inherit
      secrets: "inherit",
      with: {
        doppler_config: "prd",
        docker_platform: "linux/amd64",
        skip_load: false,
        update_doppler: false,
      },
    },
    "notify-build-sandbox-image": {
      needs: ["variables", "slack-ci-start", "build-sandbox-image"],
      if: `${isPrd} && !cancelled()`,
      ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
      steps: [
        ...utils.setupRepo,
        await utils.githubScript(import.meta, async function notify_build_sandbox_image() {
          const { getSlackClient, slackChannelIds } = await import("../utils/slack.ts");
          const slack = getSlackClient("${{ secrets.SLACK_CI_BOT_TOKEN }}");
          const failed = "${{ needs.build-sandbox-image.result }}" === "failure";
          const emoji = failed ? "❌" : "✅";
          const suffix = failed ? "" : "\n_running Fly sandbox tests →_";
          await slack.chat.postMessage({
            channel: slackChannelIds["#building"],
            thread_ts: "${{ needs.slack-ci-start.outputs.thread_ts }}",
            text: `${emoji} Sandbox image built${suffix}`,
          });
        }),
      ],
    },
    "test-sandbox-fly": {
      needs: ["variables", "build-sandbox-image"],
      if: isPrd,
      uses: "./.github/workflows/sandbox-test-fly.yml",
      // @ts-expect-error - reusable workflow supports secrets: inherit
      secrets: "inherit",
      with: {
        doppler_config: "prd",
        fly_image_tag: "${{ needs.build-sandbox-image.outputs.fly_image_tag }}",
      },
    },
    "notify-test-sandbox-fly": {
      needs: ["variables", "slack-ci-start", "test-sandbox-fly"],
      if: `${isPrd} && !cancelled()`,
      ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
      steps: [
        ...utils.setupRepo,
        await utils.githubScript(import.meta, async function notify_test_sandbox_fly() {
          const { getSlackClient, slackChannelIds } = await import("../utils/slack.ts");
          const slack = getSlackClient("${{ secrets.SLACK_CI_BOT_TOKEN }}");
          const failed = "${{ needs.test-sandbox-fly.result }}" === "failure";
          const emoji = failed ? "❌" : "✅";
          const suffix = failed ? "" : "\n_promoting image + final deploy →_";
          await slack.chat.postMessage({
            channel: slackChannelIds["#building"],
            thread_ts: "${{ needs.slack-ci-start.outputs.thread_ts }}",
            text: `${emoji} Fly sandbox tests passed${suffix}`,
          });
        }),
      ],
    },
    "promote-fly-default-image": {
      needs: ["variables", "build-sandbox-image", "test-sandbox-fly"],
      if: isPrd,
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
      if: isPrd,
      // @ts-expect-error - is jlarky wrong here? https://github.com/JLarky/gha-ts/pull/46
      secrets: "inherit",
      with: {
        stage: "${{ needs.variables.outputs.stage }}",
      },
    },
    "notify-deploy": {
      needs: ["variables", "slack-ci-start", "deploy"],
      if: `${isPrd} && !cancelled()`,
      ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
      steps: [
        ...utils.setupRepo,
        await utils.githubScript(import.meta, async function notify_deploy() {
          const { getSlackClient, slackChannelIds } = await import("../utils/slack.ts");
          const slack = getSlackClient("${{ secrets.SLACK_CI_BOT_TOKEN }}");
          const failed = "${{ needs.deploy.result }}" === "failure";
          await slack.chat.postMessage({
            channel: slackChannelIds["#building"],
            thread_ts: "${{ needs.slack-ci-start.outputs.thread_ts }}",
            text: failed
              ? "❌ Final deploy failed"
              : "✅ OS worker deployed with new image — all done!",
          });
        }),
      ],
    },
    slack_failure: {
      needs: [
        "variables",
        "slack-ci-start",
        "deploy-os-early",
        "build-sandbox-image",
        "test-sandbox-fly",
        "promote-fly-default-image",
        "deploy",
      ],
      if: `always() && contains(needs.*.result, 'failure')`,
      ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
      env: {
        NEEDS: "${{ toJson(needs) }}",
        THREAD_TS: "${{ needs.slack-ci-start.outputs.thread_ts }}",
      },
      steps: [
        ...utils.setupRepo,
        await utils.githubScript(import.meta, async function notify_slack_on_failure() {
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

          // Post to #error-pulse (top-level)
          await slack.chat.postMessage({
            channel: slackChannelIds["#error-pulse"],
            text: message,
          });

          // Also post failure summary to the CI thread in #building
          const threadTs = process.env.THREAD_TS;
          if (threadTs) {
            await slack.chat.postMessage({
              channel: slackChannelIds["#building"],
              thread_ts: threadTs,
              text: `🚨 CI failed: ${failedJobs.join(", ")}`,
            });
          }
        }),
      ],
    },
  },
} satisfies Workflow;
