import { workflow } from "@jlarky/gha-ts/workflow-types";
import type { CloudflarePreviewApp as CloudflareApp } from "../../../scripts/preview/apps.ts";
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
      "pull-requests": "write",
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
            env: {
              APP: app.slug,
              GITHUB_TOKEN: "${{ secrets.ITERATE_BOT_GITHUB_TOKEN || github.token }}",
              SEMAPHORE_BASE_URL: "https://semaphore.iterate.com",
            },
            run: [
              "set -euo pipefail",
              "pnpm preview sync \\",
              '  --app "$APP" \\',
              '  --github-token "$GITHUB_TOKEN" \\',
              '  --pull-request-head-ref-name "${{ github.event.pull_request.head.ref }}" \\',
              '  --pull-request-head-sha "${{ github.event.pull_request.head.sha }}" \\',
              '  --pull-request-base-sha "${{ github.event.pull_request.base.sha }}" \\',
              '  --pull-request-number "${{ github.event.pull_request.number }}" \\',
              '  --repository-full-name "${{ github.repository }}" \\',
              '  --workflow-run-url "${{ needs.variables.outputs.run_url }}" \\',
              "  --is-fork \"${{ github.event.pull_request.head.repo.fork && 'true' || 'false' }}\" \\",
              '  --semaphore-base-url "$SEMAPHORE_BASE_URL"',
            ].join("\n"),
          },
          {
            if: "github.event.pull_request.head.repo.fork != true",
            name: `Sync ${app.displayName} preview`,
            env: {
              APP: app.slug,
              DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
              GITHUB_TOKEN: "${{ secrets.ITERATE_BOT_GITHUB_TOKEN || github.token }}",
            },
            run: [
              "set -euo pipefail",
              "doppler run --project os --config prd -- pnpm preview sync \\",
              '  --app "$APP" \\',
              '  --github-token "$GITHUB_TOKEN" \\',
              '  --pull-request-head-ref-name "${{ github.event.pull_request.head.ref }}" \\',
              '  --pull-request-head-sha "${{ github.event.pull_request.head.sha }}" \\',
              '  --pull-request-base-sha "${{ github.event.pull_request.base.sha }}" \\',
              '  --pull-request-number "${{ github.event.pull_request.number }}" \\',
              '  --repository-full-name "${{ github.repository }}" \\',
              '  --workflow-run-url "${{ needs.variables.outputs.run_url }}" \\',
              "  --is-fork \"${{ github.event.pull_request.head.repo.fork && 'true' || 'false' }}\"",
            ].join("\n"),
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
              'first_route="$(printf "%s" "$routes" | tr "," "\\n" | awk \'{ gsub(/^[[:space:]]+|[[:space:]]+$/, "", $0); if ($0 != "") { sub(/\\/\\*$/, "", $0); print; exit } }\')"',
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
