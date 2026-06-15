import { workflow } from "@jlarky/gha-ts/workflow-types";
import { cloudflareAppSharedPaths } from "../../../scripts/preview/apps.ts";
import type { CloudflarePreviewApp as CloudflareApp } from "../../../scripts/preview/apps.ts";
import * as utils from "./index.ts";

declare const appDisplayName: string;
declare const publicUrl: string;
declare const runUrl: string;
declare const shortSha: string;
declare const slackChannelName: string;

export async function createCloudflareAppWorkflow(meta: ImportMeta, app: CloudflareApp) {
  const workflowName = meta.url.split("/").pop()?.replace(/\.ts$/, "");
  if (!workflowName) throw new Error("Unable to resolve workflow name");
  const workflowDefinitionPaths = [
    `.github/ts-workflows/workflows/${workflowName}.ts`,
    `.github/workflows/${workflowName}.yml`,
  ];

  return workflow({
    name: `Deploy ${app.displayName}`,
    permissions: {
      contents: "read",
      deployments: "write",
    },
    concurrency: {
      group: `${app.slug}-\${{ github.ref_name || 'prd' }}`,
      "cancel-in-progress": true,
    },
    on: {
      push: {
        branches: ["main"],
        paths: [...workflowDefinitionPaths, ...app.paths, ...cloudflareAppSharedPaths],
      },
      workflow_dispatch: {
        inputs: {
          ref: {
            description: "Git ref to deploy. Leave empty for the current branch or commit.",
            required: false,
            type: "string",
            default: "",
          },
        },
      },
    },
    jobs: {
      variables: {
        ...utils.runsOnDepotUbuntu,
        outputs: {
          run_url: "${{ steps.vars.outputs.run_url }}",
          short_sha: "${{ steps.vars.outputs.short_sha }}",
        },
        steps: [
          {
            id: "vars",
            name: "Resolve workflow variables",
            env: {
              GIT_SHA: "${{ github.sha }}",
            },
            run: [
              'echo "short_sha=${GIT_SHA:0:7}" >> "$GITHUB_OUTPUT"',
              'echo "run_url=${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}" >> "$GITHUB_OUTPUT"',
            ].join("\n"),
          },
        ],
      },
      deploy: {
        needs: ["variables"],
        if: "github.event_name == 'push' || github.event_name == 'workflow_dispatch'",
        ...utils.runsOnDepotUbuntu,
        outputs: {
          public_url: "${{ steps.metadata.outputs.public_url }}",
        },
        steps: [
          ...utils.getSetupRepo({
            ref: "${{ inputs.ref || github.sha }}",
          }),
          ...utils.setupDoppler({
            config: "prd",
            project: app.dopplerProject,
          }),
          {
            id: "metadata",
            name: `Resolve ${app.displayName} deploy URL`,
            env: {
              DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            },
            run: [
              "set -euo pipefail",
              'public_url="$(doppler run -- node -e \'const env=process.env; const appConfig=env.APP_CONFIG?.trim()?JSON.parse(env.APP_CONFIG):{}; console.log(env.APP_CONFIG_BASE_URL || appConfig.baseUrl || "");\')"',
              'if [ -n "$public_url" ]; then',
              '  echo "public_url=${public_url}" >> "$GITHUB_OUTPUT"',
              "fi",
            ].join("\n"),
          },
          {
            name: `Deploy ${app.appPath}`,
            "working-directory": app.appPath,
            env: {
              DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            },
            run: "doppler run -- pnpm tsx ./alchemy.run.ts",
          },
        ],
      },
      "slack-success": {
        needs: ["variables", "deploy"],
        if: "github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.deploy.result == 'success'",
        ...utils.runsOnDepotUbuntu,
        steps: [
          ...utils.setupRepo,
          await utils.githubScript(
            meta,
            {
              params: {
                appDisplayName: app.displayName,
                publicUrl: "${{ needs.deploy.outputs.public_url }}",
                runUrl: "${{ needs.variables.outputs.run_url }}",
                shortSha: "${{ needs.variables.outputs.short_sha }}",
                slackChannelName: "#ci",
              },
            },
            async function notify_slack_on_success() {
              const { getSlackClient, slackChannelIds } = await import("../utils/slack.ts");
              const slack = getSlackClient("${{ secrets.SLACK_CI_BOT_TOKEN }}");
              const message = [
                `✅ ${appDisplayName} prd deploy succeeded (${shortSha})`,
                publicUrl ? `<${publicUrl}|Open app>` : null,
                `<${runUrl}|View workflow run>`,
              ]
                .filter(Boolean)
                .join(" · ");

              await slack.chat.postMessage({
                channel:
                  slackChannelIds[slackChannelName as keyof typeof slackChannelIds] ??
                  slackChannelName,
                text: message,
              });
            },
          ),
        ],
      },
      "slack-failure": {
        needs: ["variables", "deploy"],
        if: "always() && github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.deploy.result == 'failure'",
        ...utils.runsOnDepotUbuntu,
        steps: [
          ...utils.setupRepo,
          await utils.githubScript(
            meta,
            {
              params: {
                appDisplayName: app.displayName,
                runUrl: "${{ needs.variables.outputs.run_url }}",
                shortSha: "${{ needs.variables.outputs.short_sha }}",
                slackChannelName: "#ci",
              },
            },
            async function notify_slack_on_failure() {
              const { getSlackClient, slackChannelIds } = await import("../utils/slack.ts");
              const slack = getSlackClient("${{ secrets.SLACK_CI_BOT_TOKEN }}");
              const message = [
                `🚨 ${appDisplayName} prd deploy failed (${shortSha}).`,
                `<${runUrl}|View workflow run>`,
                "@iterate please investigate",
              ].join(" ");

              await slack.chat.postMessage({
                channel:
                  slackChannelIds[slackChannelName as keyof typeof slackChannelIds] ??
                  slackChannelName,
                text: message,
              });
            },
          ),
        ],
      },
    },
  });
}
