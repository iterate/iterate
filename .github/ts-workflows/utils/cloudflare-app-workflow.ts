import { workflow } from "@jlarky/gha-ts/workflow-types";
import type { CloudflareApp } from "./cloudflare-apps.ts";
import * as utils from "./index.ts";

declare const appDisplayName: string;
declare const publicUrl: string;
declare const runUrl: string;
declare const shortSha: string;
declare const stage: string;

export async function createCloudflareAppWorkflow(meta: ImportMeta, app: CloudflareApp) {
  return workflow({
    name: `Deploy ${app.displayName}`,
    permissions: {
      contents: "read",
      deployments: "write",
      issues: "write",
    },
    concurrency: {
      group: `${app.slug}-\${{ github.event.pull_request.number || github.ref_name || inputs.stage || 'prd' }}`,
      "cancel-in-progress": true,
    },
    on: {
      pull_request: {
        types: ["opened", "reopened", "synchronize"],
        paths: app.paths,
      },
      push: {
        branches: ["main"],
        paths: app.paths,
      },
      workflow_dispatch: {
        inputs: {
          ref: {
            description: "Git ref to deploy. Leave empty for the current branch or commit.",
            required: false,
            type: "string",
            default: "",
          },
          stage: {
            description: "Doppler config to deploy for manual runs.",
            required: false,
            type: "string",
            default: "prd",
          },
        },
      },
    },
    jobs: {
      variables: {
        ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
        outputs: {
          run_url: "${{ steps.vars.outputs.run_url }}",
          short_sha: "${{ steps.vars.outputs.short_sha }}",
          stage: "${{ steps.vars.outputs.stage }}",
        },
        steps: [
          {
            id: "vars",
            name: "Resolve workflow variables",
            env: {
              GIT_SHA: "${{ github.event.pull_request.head.sha || github.sha }}",
            },
            run: [
              "echo \"stage=${{ github.event_name == 'push' && 'prd' || inputs.stage || 'prd' }}\" >> \"$GITHUB_OUTPUT\"",
              'echo "short_sha=${GIT_SHA:0:7}" >> "$GITHUB_OUTPUT"',
              'echo "run_url=${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}" >> "$GITHUB_OUTPUT"',
            ].join("\n"),
          },
        ],
      },
      "preview-pr": {
        needs: ["variables"],
        if: "github.event_name == 'pull_request'",
        ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
        steps: [
          ...utils.getSetupRepo({
            ref: "${{ github.event.pull_request.head.sha || github.sha }}",
          }),
          {
            ...utils.installDopplerCli,
            if: "github.event.pull_request.head.repo.fork != true",
          },
          {
            if: "github.event.pull_request.head.repo.fork == true",
            name: `Sync ${app.displayName} preview`,
            "working-directory": app.appPath,
            env: {
              GITHUB_HEAD_REF: "${{ github.event.pull_request.head.ref }}",
              GITHUB_PR_IS_FORK:
                "${{ github.event.pull_request.head.repo.fork && 'true' || 'false' }}",
              GITHUB_PR_NUMBER: "${{ github.event.pull_request.number }}",
              GITHUB_REPOSITORY: "${{ github.repository }}",
              GITHUB_RUN_ID: "${{ github.run_id }}",
              GITHUB_SERVER_URL: "${{ github.server_url }}",
              GITHUB_SHA: "${{ github.event.pull_request.head.sha }}",
              GITHUB_TOKEN: "${{ github.token }}",
              WORKFLOW_RUN_URL: "${{ needs.variables.outputs.run_url }}",
            },
            run: "pnpm iterate --local-router ./scripts/router.ts local-router preview-sync-pr",
          },
          {
            if: "github.event.pull_request.head.repo.fork != true",
            name: `Sync ${app.displayName} preview`,
            "working-directory": app.appPath,
            env: {
              DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
              GITHUB_HEAD_REF: "${{ github.event.pull_request.head.ref }}",
              GITHUB_PR_IS_FORK:
                "${{ github.event.pull_request.head.repo.fork && 'true' || 'false' }}",
              GITHUB_PR_NUMBER: "${{ github.event.pull_request.number }}",
              GITHUB_REPOSITORY: "${{ github.repository }}",
              GITHUB_RUN_ID: "${{ github.run_id }}",
              GITHUB_SERVER_URL: "${{ github.server_url }}",
              GITHUB_SHA: "${{ github.event.pull_request.head.sha }}",
              GITHUB_TOKEN: "${{ github.token }}",
              WORKFLOW_RUN_URL: "${{ needs.variables.outputs.run_url }}",
            },
            run: "doppler run --project os --config prd -- pnpm iterate --local-router ./scripts/router.ts local-router preview-sync-pr",
          },
        ],
      },
      deploy: {
        needs: ["variables"],
        if: "github.event_name == 'push' || github.event_name == 'workflow_dispatch'",
        ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
        outputs: {
          public_url: "${{ steps.metadata.outputs.public_url }}",
        },
        steps: [
          ...utils.getSetupRepo({
            ref: "${{ inputs.ref || github.sha }}",
          }),
          ...utils.setupDoppler({
            config: "${{ needs.variables.outputs.stage }}",
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
              'routes="$(doppler secrets get WORKER_ROUTES --plain 2>/dev/null || true)"',
              'first_route="$(printf "%s" "$routes" | tr "," "\\n" | sed -e "s#/\\*$##" -e "s#^[[:space:]]*##" -e "s#[[:space:]]*$##" | awk \'NF { print; exit }\')"',
              'if [ -n "$first_route" ]; then',
              '  echo "public_url=https://${first_route}" >> "$GITHUB_OUTPUT"',
              "fi",
            ].join("\n"),
          },
          {
            name: `Deploy ${app.appPath}`,
            "working-directory": app.appPath,
            env: {
              DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            },
            run: "doppler run -- pnpm alchemy:up",
          },
        ],
      },
      "slack-success": {
        needs: ["variables", "deploy"],
        if: "github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.deploy.result == 'success'",
        ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
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
                stage: "${{ needs.variables.outputs.stage }}",
              },
            },
            async function notify_slack_on_success() {
              const { getSlackClient, slackChannelIds } = await import("../utils/slack.ts");
              const slack = getSlackClient("${{ secrets.SLACK_CI_BOT_TOKEN }}");
              const message = [
                `✅ ${appDisplayName} ${stage} deploy succeeded (${shortSha})`,
                publicUrl ? `<${publicUrl}|Open app>` : null,
                `<${runUrl}|View workflow run>`,
              ]
                .filter(Boolean)
                .join(" · ");

              await slack.chat.postMessage({
                channel: slackChannelIds["#building"],
                text: message,
              });
            },
          ),
        ],
      },
      "slack-failure": {
        needs: ["variables", "deploy"],
        if: "always() && github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.deploy.result == 'failure'",
        ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
        steps: [
          ...utils.setupRepo,
          await utils.githubScript(
            meta,
            {
              params: {
                appDisplayName: app.displayName,
                runUrl: "${{ needs.variables.outputs.run_url }}",
                shortSha: "${{ needs.variables.outputs.short_sha }}",
                stage: "${{ needs.variables.outputs.stage }}",
              },
            },
            async function notify_slack_on_failure() {
              const { getSlackClient, slackChannelIds } = await import("../utils/slack.ts");
              const slack = getSlackClient("${{ secrets.SLACK_CI_BOT_TOKEN }}");
              const message = [
                `🚨 ${appDisplayName} ${stage} deploy failed (${shortSha}).`,
                `<${runUrl}|View workflow run>`,
                "@iterate please investigate",
              ].join(" ");

              await slack.chat.postMessage({
                channel: slackChannelIds["#error-pulse"],
                text: message,
              });
            },
          ),
        ],
      },
    },
  });
}
