import type { Workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default {
  name: "Deploy to Cloudflare",
  on: {
    // this should be called from ci.ts (/ci.yml)
    workflow_call: {
      inputs: {
        stage: {
          description:
            "The stage to deploy to. Must correspond to a Doppler config in the os project (prd, stg, dev, dev_bob etc.).",
          required: true,
          type: "string",
        },
      },
      outputs: {
        worker_url: {
          description: "The URL of the deployed worker.",
          value: "${{ jobs.deploy-os.outputs.worker_url }}",
        },
      },
    },
  },
  permissions: {
    contents: "read",
    deployments: "write",
  },
  jobs: {
    notify_start: {
      ...utils.runsOn,
      if: "inputs.stage == 'prd' || inputs.stage == 'stg'", // todo: rm stg once we've seen this working, it'll be too much noise
      outputs: {
        slack_message_ts: "${{ steps.slack_notify_started.outputs.slack_message_ts }}",
        slack_channel: "${{ steps.slack_notify_started.outputs.slack_channel }}",
      },
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "${{ inputs.stage }}" }),
        utils.githubScript(import.meta, async function slack_notify_started({ core }) {
          const { getSlackClient, slackChannelIds } = await import("../utils/slack.ts");
          const slack = getSlackClient("${{ secrets.SLACK_CI_BOT_TOKEN }}");
          const message = await slack.chat.postMessage({
            channel: slackChannelIds["#building"],
            text: "${{ inputs.stage }} <${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}|deploy started>.",
          });
          core.setOutput("slack_channel", message.channel);
          core.setOutput("slack_message_ts", message.ts);
        }),
      ],
    },
    notify_end: {
      ...utils.runsOn,
      needs: ["notify_start"],
      if: "always() && needs.notify_start.outputs.slack_message_ts",
      steps: [
        utils.githubScript(import.meta, async function slack_notify_ended() {
          const { getSlackClient } = await import("../utils/slack.ts");
          const slack = getSlackClient("${{ secrets.SLACK_CI_BOT_TOKEN }}");
          const succeeded = "${{ success() }}".includes("true");
          await slack.chat.postMessage({
            channel: "${{ needs.notify_start.outputs.slack_channel }}",
            thread_ts: "${{ needs.notify_start.outputs.slack_message_ts }}",
            text: succeeded ? "Deploy completed" : "Deploy failed",
          });
        }),
      ],
    },
    "deploy-os": {
      "timeout-minutes": 15,
      ...utils.runsOn,
      outputs: {
        worker_url: "${{ steps.alchemy_deploy.outputs.worker_url }}",
      },
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "${{ inputs.stage }}" }),
        {
          name: "Enable QEMU",
          uses: "docker/setup-qemu-action@v3",
          with: {
            platforms: "all",
          },
        },
        {
          id: "alchemy_deploy",
          name: "Deploy using Alchemy",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            STAGE: "${{ inputs.stage }}",
          },
          run: "pnpm run deploy",
          "working-directory": "apps/os",
        },
      ],
    },
    "deploy-website": {
      "runs-on":
        "${{ github.repository_owner == 'iterate' && 'depot-ubuntu-24.04-arm-4' || 'ubuntu-24.04' }}",
      if: "inputs.stage == 'prd'",
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "${{ inputs.stage }}" }),
        {
          name: "Deploy Website",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: "pnpm run deploy",
          "working-directory": "estates/iterate/apps/website",
        },
      ],
    },
    "deploy-mcp-mock-server": {
      "runs-on":
        "${{ github.repository_owner == 'iterate' && 'depot-ubuntu-24.04-arm-4' || 'ubuntu-24.04' }}",
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "${{ inputs.stage }}" }),
        {
          name: "Deploy Mock MCP Server",
          "working-directory": "apps/mcp-mock-server",
          run: "pnpm run deploy",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            STAGE: "${{ inputs.stage }}",
          },
        },
      ],
    },
  },
} satisfies Workflow;
