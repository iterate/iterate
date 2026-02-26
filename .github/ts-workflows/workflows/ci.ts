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
const baseWorkflow = {
  name: "CI",
  permissions: {
    contents: "read",
    deployments: "write",
    "id-token": "write", // Required for Depot OIDC auth in called workflows
  },
  on: {
    push: {
      branches: ["main", "mmkal/26/02/25/extraextraslack"],
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
      secrets: "inherit",
      with: {
        stage: "${{ needs.variables.outputs.stage }}",
      },
    },
  },
} satisfies Workflow;

export default await addSlackNotifications(baseWorkflow, "#misha-test");

async function addSlackNotifications(
  workflow: Workflow,
  channel: import("../utils/slack.ts").SlackChannelName,
) {
  const jobs = Object.entries(workflow.jobs);
  const newJobs: typeof jobs = [];
  newJobs.push([
    "notification_init",
    {
      ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
      steps: [
        ...utils.setupRepo,
        {
          id: "notification_init",
          name: "Initialize notification thread",
          ...(await utils.githubScript(
            import.meta,
            { params: { workflow: { name: workflow.name }, channel } },
            async function notification_init({ core }) {
              const { getSlackClient, slackChannelIds } = await import("../utils/slack.ts");
              const slack = getSlackClient("${{ secrets.SLACK_CI_BOT_TOKEN }}");
              let message = `Starting ${workflow.name}`;
              message +=
                " <${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}|View Workflow Run>";
              const response = await slack.chat.postMessage({
                channel: slackChannelIds[channel],
                text: message,
              });
              console.log("response", response);
              core.setOutput("thread_ts", response.ts);
            },
          )),
        },
      ],
      outputs: {
        thread_ts: "${{ steps.notification_init.outputs.thread_ts }}",
      },
    },
  ]);

  for (const [name, job] of jobs) {
    newJobs.push([
      `${name}_notification_before`,
      {
        ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
        needs: ["notification_init"],
        env: { NEEDS: "${{ toJson(needs) }}" },
        steps: [
          ...utils.setupRepo,
          {
            id: `${name}_notification_before`,
            ...(await utils.githubScript(
              import.meta,
              { params: { name, channel } },
              async function notification_before() {
                console.log("${{ needs.notification_init.outputs.thread_ts }}", process.env.NEEDS);
                const { getSlackClient, slackChannelIds } = await import("../utils/slack.ts");
                const slack = getSlackClient("${{ secrets.SLACK_CI_BOT_TOKEN }}");
                await slack.chat.postMessage({
                  channel: slackChannelIds[channel],
                  text: `Starting ${name}`,
                  thread_ts: "${{ needs.notification_init.outputs.thread_ts }}",
                });
              },
            )),
          },
        ],
      },
    ]);
    newJobs.push([name, job]);
    newJobs.push([
      `${name}_notification_after_success`,
      {
        ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
        needs: ["notification_init", `${name}_notification_before`, name],
        if: `needs.${name}.result == 'success'`,
        steps: [
          ...utils.setupRepo,
          {
            id: `${name}_notification_after`,
            ...(await utils.githubScript(
              import.meta,
              { params: { name, channel } },
              async function notification_after() {
                const { getSlackClient, slackChannelIds } = await import("../utils/slack.ts");
                const slack = getSlackClient("${{ secrets.SLACK_CI_BOT_TOKEN }}");
                await slack.chat.postMessage({
                  channel: slackChannelIds[channel],
                  text: `✅ Finished ${name}`,
                  thread_ts: "${{ needs.notification_init.outputs.thread_ts }}",
                });
              },
            )),
          },
        ],
      },
    ]);
    newJobs.push([
      `${name}_notification_after_failure`,
      {
        ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
        needs: ["notification_init", `${name}_notification_before`, name],
        if: `always() && needs.${name}.result != 'success'`,
        steps: [
          ...utils.setupRepo,
          {
            id: `${name}_notification_failure`,
            ...(await utils.githubScript(
              import.meta,
              { params: { name, channel } },
              async function notification_after() {
                const { getSlackClient, slackChannelIds } = await import("../utils/slack.ts");
                const slack = getSlackClient("${{ secrets.SLACK_CI_BOT_TOKEN }}");
                await slack.reactions.add({
                  channel: slackChannelIds[channel],
                  timestamp: "${{ needs.notification_init.outputs.thread_ts }}",
                  name: "thumbsdown",
                });
                await slack.chat.postMessage({
                  channel: slackChannelIds[channel],
                  text: `❌ Failed ${name}`,
                  thread_ts: "${{ needs.notification_init.outputs.thread_ts }}",
                });
              },
            )),
          },
        ],
      },
    ]);
  }
  return {
    ...workflow,
    jobs: Object.fromEntries(newJobs),
  };
}
