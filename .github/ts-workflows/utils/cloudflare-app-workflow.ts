import { workflow } from "@jlarky/gha-ts/workflow-types";
import type { CloudflareApp } from "./cloudflare-apps.ts";
import * as utils from "./index.ts";

declare const appDisplayName: string;
declare const appSlug: string;
declare const deployResult: string;
declare const isFork: string;
declare const previewCommentMarker: string;
declare const previewCommentStateLabel: string;
declare const previewJson: string;
declare const previewResult: string;
declare const publicUrl: string;
declare const runUrl: string;
declare const shortSha: string;
declare const stage: string;
declare const testResult: string;

const previewCommentMarkerValue = "<!-- CLOUDFLARE_PREVIEW_ENVIRONMENTS -->";
const previewCommentStateLabelValue = "CLOUDFLARE_PREVIEW_ENVIRONMENTS_STATE";
const previewLeaseMs = 6 * 60 * 60 * 1000;

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
          is_fork: "${{ steps.vars.outputs.is_fork }}",
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
              "echo \"is_fork=${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.fork && 'true' || 'false' }}\" >> \"$GITHUB_OUTPUT\"",
              'echo "short_sha=${GIT_SHA:0:7}" >> "$GITHUB_OUTPUT"',
              'echo "run_url=${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}" >> "$GITHUB_OUTPUT"',
            ].join("\n"),
          },
        ],
      },
      preview: {
        needs: ["variables"],
        if: "github.event_name == 'pull_request' && needs.variables.outputs.is_fork != 'true'",
        ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
        outputs: {
          preview_json: "${{ steps.preview.outputs.preview_json }}",
        },
        steps: [
          ...utils.getSetupRepo({
            ref: "${{ github.event.pull_request.head.sha || github.sha }}",
          }),
          ...utils.setupDoppler({
            config: "prd",
            project: "semaphore",
          }),
          {
            id: "preview",
            name: `Claim ${app.displayName} preview environment`,
            "working-directory": "apps/semaphore",
            env: {
              DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
              PREVIEW_ENVIRONMENT_APP_SLUG: app.slug,
              PREVIEW_LEASE_MS: String(previewLeaseMs),
              PULL_REQUEST_HEAD_REF_NAME: "${{ github.event.pull_request.head.ref }}",
              PULL_REQUEST_HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
              PULL_REQUEST_NUMBER: "${{ github.event.pull_request.number }}",
              REPOSITORY_FULL_NAME: "${{ github.repository }}",
              WORKFLOW_RUN_URL: "${{ needs.variables.outputs.run_url }}",
            },
            run: [
              "set -euo pipefail",
              'preview_json="$(doppler run -- pnpm exec tsx ./scripts/preview-workflow.ts create)"',
              'echo "preview_json<<EOF" >> "$GITHUB_OUTPUT"',
              'echo "$preview_json" >> "$GITHUB_OUTPUT"',
              'echo "EOF" >> "$GITHUB_OUTPUT"',
            ].join("\n"),
          },
        ],
      },
      deploy: {
        needs: ["variables", "preview"],
        if: "(github.event_name == 'push') || (github.event_name == 'workflow_dispatch') || (github.event_name == 'pull_request' && needs.variables.outputs.is_fork != 'true' && needs.preview.result == 'success')",
        ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
        outputs: {
          public_url: "${{ steps.metadata.outputs.public_url }}",
        },
        steps: [
          ...utils.getSetupRepo({
            ref: "${{ inputs.ref || github.event.pull_request.head.sha || github.sha }}",
          }),
          ...utils.setupDoppler({
            config:
              "${{ github.event_name == 'pull_request' && fromJson(needs.preview.outputs.preview_json).previewEnvironmentDopplerConfigName || needs.variables.outputs.stage }}",
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
              'if [ "${{ github.event_name }}" = "pull_request" ]; then',
              '  echo "public_url=https://${{ fromJson(needs.preview.outputs.preview_json).previewEnvironmentWorkersDevHostname }}" >> "$GITHUB_OUTPUT"',
              "  exit 0",
              "fi",
              'routes="$(doppler secrets get WORKER_ROUTES --plain 2>/dev/null || true)"',
              'first_route="$(printf "%s" "$routes" | tr "," "\\n" | sed -e "s#/\\*$##" -e "s#^[[:space:]]*##" -e "s#[[:space:]]*$##" | awk \'NF { print; exit }\')"',
              'if [ -n "$first_route" ]; then',
              '  echo "public_url=https://${first_route}" >> "$GITHUB_OUTPUT"',
              "fi",
            ].join("\n"),
          },
          {
            name: `Recreate ${app.displayName} preview deployment`,
            if: "github.event_name == 'pull_request'",
            "working-directory": app.appPath,
            env: {
              DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            },
            run: "doppler run -- pnpm alchemy:down || true",
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
      "test-preview": {
        needs: ["variables", "preview", "deploy"],
        if: "github.event_name == 'pull_request' && needs.variables.outputs.is_fork != 'true' && needs.preview.result == 'success' && needs.deploy.result == 'success'",
        ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
        steps: [
          ...utils.getSetupRepo({
            ref: "${{ github.event.pull_request.head.sha || github.sha }}",
          }),
          ...utils.setupDoppler({
            config:
              "${{ fromJson(needs.preview.outputs.preview_json).previewEnvironmentDopplerConfigName }}",
            project: app.dopplerProject,
          }),
          {
            name: `Run ${app.displayName} preview tests`,
            "working-directory": app.appPath,
            env: {
              DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
              [app.previewTest.baseUrlEnvVar]: "${{ needs.deploy.outputs.public_url }}",
            },
            run: `doppler run -- ${app.previewTest.command}`,
          },
        ],
      },
      "comment-pr": {
        needs: ["variables", "preview", "deploy", "test-preview"],
        if: "always() && github.event_name == 'pull_request'",
        ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
        steps: [
          await utils.githubScript(
            meta,
            {
              params: {
                appDisplayName: app.displayName,
                appSlug: app.slug,
                deployResult: "${{ needs.deploy.result }}",
                isFork: "${{ needs.variables.outputs.is_fork }}",
                previewCommentMarker: previewCommentMarkerValue,
                previewCommentStateLabel: previewCommentStateLabelValue,
                previewJson: "${{ needs.preview.outputs.preview_json }}",
                previewResult: "${{ needs.preview.result }}",
                publicUrl: "${{ needs.deploy.outputs.public_url }}",
                runUrl: "${{ needs.variables.outputs.run_url }}",
                shortSha: "${{ needs.variables.outputs.short_sha }}",
                testResult: "${{ needs['test-preview'].result }}",
              },
            },
            async function update_pr_comment({ context, github }) {
              const pr = context.payload.pull_request;
              if (!pr) return;

              const { readPreviewCommentState, renderPreviewCommentBody } =
                await import("../utils/cloudflare-preview-comment.ts");
              const now = new Date().toISOString();

              const existingComments = await github.rest.issues.listComments({
                ...context.repo,
                issue_number: pr.number,
                per_page: 100,
              });
              const existingComment = existingComments.data.find((comment) =>
                comment.body?.includes(previewCommentMarker),
              );
              const currentState = readPreviewCommentState({
                body: existingComment?.body ?? `${previewCommentMarker}\n## Preview Environments`,
                previewCommentMarker,
                previewCommentStateLabel,
              }).currentState;

              const previewEnvironment =
                previewJson && previewJson !== ""
                  ? (JSON.parse(previewJson) as {
                      leasedUntil: number | null;
                      previewEnvironmentAlchemyStageName: string;
                      previewEnvironmentDopplerConfigName: string;
                      previewEnvironmentIdentifier: string;
                      previewEnvironmentSemaphoreLeaseId: string | null;
                      previewEnvironmentWorkersDevHostname: string;
                    })
                  : null;

              const nextState = {
                ...currentState,
                [appSlug]:
                  isFork === "true"
                    ? {
                        appDisplayName,
                        message: "Preview environments are unavailable for fork pull requests.",
                        runUrl,
                        shortSha,
                        status: "fork-unavailable",
                        updatedAt: now,
                      }
                    : previewResult !== "success"
                      ? {
                          appDisplayName,
                          message: "Failed to claim a preview environment.",
                          runUrl,
                          shortSha,
                          status: "claim-failed",
                          updatedAt: now,
                        }
                      : deployResult !== "success"
                        ? {
                            appDisplayName,
                            leasedUntil: previewEnvironment?.leasedUntil ?? null,
                            message: "Preview deployment failed.",
                            previewEnvironmentAlchemyStageName:
                              previewEnvironment?.previewEnvironmentAlchemyStageName ?? null,
                            previewEnvironmentDopplerConfigName:
                              previewEnvironment?.previewEnvironmentDopplerConfigName ?? null,
                            previewEnvironmentIdentifier:
                              previewEnvironment?.previewEnvironmentIdentifier ?? null,
                            previewEnvironmentSemaphoreLeaseId:
                              previewEnvironment?.previewEnvironmentSemaphoreLeaseId ?? null,
                            publicUrl: publicUrl || null,
                            runUrl,
                            shortSha,
                            status: "deploy-failed",
                            updatedAt: now,
                          }
                        : testResult === "failure"
                          ? {
                              appDisplayName,
                              leasedUntil: previewEnvironment?.leasedUntil ?? null,
                              message: "Preview tests failed after deploy.",
                              previewEnvironmentAlchemyStageName:
                                previewEnvironment?.previewEnvironmentAlchemyStageName ?? null,
                              previewEnvironmentDopplerConfigName:
                                previewEnvironment?.previewEnvironmentDopplerConfigName ?? null,
                              previewEnvironmentIdentifier:
                                previewEnvironment?.previewEnvironmentIdentifier ?? null,
                              previewEnvironmentSemaphoreLeaseId:
                                previewEnvironment?.previewEnvironmentSemaphoreLeaseId ?? null,
                              publicUrl,
                              runUrl,
                              shortSha,
                              status: "tests-failed",
                              updatedAt: now,
                            }
                          : {
                              appDisplayName,
                              leasedUntil: previewEnvironment?.leasedUntil ?? null,
                              previewEnvironmentAlchemyStageName:
                                previewEnvironment?.previewEnvironmentAlchemyStageName ?? null,
                              previewEnvironmentDopplerConfigName:
                                previewEnvironment?.previewEnvironmentDopplerConfigName ?? null,
                              previewEnvironmentIdentifier:
                                previewEnvironment?.previewEnvironmentIdentifier ?? null,
                              previewEnvironmentSemaphoreLeaseId:
                                previewEnvironment?.previewEnvironmentSemaphoreLeaseId ?? null,
                              publicUrl,
                              runUrl,
                              shortSha,
                              status: "deployed",
                              updatedAt: now,
                            },
              } satisfies import("./cloudflare-preview-comment.ts").PreviewCommentState;

              const body = renderPreviewCommentBody({
                previewCommentMarker,
                previewCommentStateLabel,
                state: nextState,
              });

              if (existingComment) {
                await github.rest.issues.updateComment({
                  ...context.repo,
                  body,
                  comment_id: existingComment.id,
                });
                return;
              }

              await github.rest.issues.createComment({
                ...context.repo,
                body,
                issue_number: pr.number,
              });
            },
          ),
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
