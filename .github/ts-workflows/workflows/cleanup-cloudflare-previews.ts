import { workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

declare const cleanupResult: string;
declare const previewCommentMarker: string;
declare const previewCommentStateLabel: string;
declare const previewJson: string;

const previewCommentMarkerValue = "<!-- CLOUDFLARE_PREVIEW_ENVIRONMENTS -->";
const previewCommentStateLabelValue = "CLOUDFLARE_PREVIEW_ENVIRONMENTS_STATE";

export default workflow({
  name: "Cleanup Cloudflare Previews",
  on: {
    pull_request: {
      types: ["closed"],
    },
  },
  jobs: {
    discover: {
      ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
      outputs: {
        preview_json: "${{ steps.discover.outputs.preview_json }}",
        preview_matrix: "${{ steps.discover.outputs.preview_matrix }}",
      },
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({
          config: "prd",
          project: "semaphore",
        }),
        {
          id: "discover",
          name: "Discover preview environments to destroy",
          "working-directory": "apps/semaphore",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            PULL_REQUEST_NUMBER: "${{ github.event.pull_request.number || '' }}",
            REPOSITORY_FULL_NAME: "${{ github.repository }}",
          },
          run: [
            "set -euo pipefail",
            'preview_json="$(doppler run -- pnpm exec tsx ./scripts/preview-workflow.ts list-for-pr)"',
            'echo "preview_json<<EOF" >> "$GITHUB_OUTPUT"',
            'echo "$preview_json" >> "$GITHUB_OUTPUT"',
            'echo "EOF" >> "$GITHUB_OUTPUT"',
            'echo "preview_matrix<<EOF" >> "$GITHUB_OUTPUT"',
            `PREVIEW_JSON="$preview_json" pnpm exec tsx -e '
const previewEnvironments = JSON.parse(process.env.PREVIEW_JSON ?? "[]");
console.log(
  JSON.stringify(
    previewEnvironments.map((previewEnvironment) => ({
      previewEnvironmentAppSlug: previewEnvironment.previewEnvironmentAppSlug,
      previewEnvironmentDopplerConfigName: previewEnvironment.previewEnvironmentDopplerConfigName,
      previewEnvironmentIdentifier: previewEnvironment.previewEnvironmentIdentifier,
      previewEnvironmentSemaphoreLeaseId: previewEnvironment.previewEnvironmentSemaphoreLeaseId,
    })),
  ),
);
' >> "$GITHUB_OUTPUT"`,
            'echo "EOF" >> "$GITHUB_OUTPUT"',
          ].join("\n"),
        },
      ],
    },
    cleanup: {
      needs: ["discover"],
      if: "${{ needs.discover.outputs.preview_matrix != '[]' }}",
      strategy: {
        matrix: {
          include: "${{ fromJson(needs.discover.outputs.preview_matrix) }}",
        },
      },
      ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({
          config: "${{ matrix.previewEnvironmentDopplerConfigName }}",
          project: "${{ matrix.previewEnvironmentAppSlug }}",
        }),
        {
          name: "Destroy Cloudflare preview deployment",
          "working-directory": "apps/${{ matrix.previewEnvironmentAppSlug }}",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: "doppler run -- pnpm alchemy:down",
        },
        ...utils.setupDoppler({
          config: "prd",
          project: "semaphore",
        }),
        {
          name: "Finalize preview release in Semaphore",
          "working-directory": "apps/semaphore",
          env: {
            DESTROY_REASON: "pull-request-closed",
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            PREVIEW_ENVIRONMENT_IDENTIFIER: "${{ matrix.previewEnvironmentIdentifier }}",
            PREVIEW_ENVIRONMENT_SEMAPHORE_LEASE_ID:
              "${{ matrix.previewEnvironmentSemaphoreLeaseId }}",
          },
          run: "doppler run -- pnpm exec tsx ./scripts/preview-workflow.ts destroy",
        },
      ],
    },
    "comment-pr": {
      needs: ["discover", "cleanup"],
      if: "always() && github.event_name == 'pull_request' && needs.discover.outputs.preview_json != '[]'",
      ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
      steps: [
        await utils.githubScript(
          import.meta,
          {
            params: {
              cleanupResult: "${{ needs.cleanup.result }}",
              previewCommentMarker: previewCommentMarkerValue,
              previewCommentStateLabel: previewCommentStateLabelValue,
              previewJson: "${{ needs.discover.outputs.preview_json }}",
            },
          },
          async function update_pr_comment_on_cleanup({ context, github }) {
            const pr = context.payload.pull_request;
            if (!pr) return;

            const { readPreviewCommentState, renderPreviewCommentBody } =
              await import("../utils/cloudflare-preview-comment.ts");
            const previewEnvironments = JSON.parse(previewJson) as Array<{
              previewEnvironmentAppSlug: string;
            }>;
            const now = new Date().toISOString();

            const existingComments = await github.rest.issues.listComments({
              ...context.repo,
              issue_number: pr.number,
              per_page: 100,
            });
            const existingComment = existingComments.data.find((comment) =>
              comment.body?.includes(previewCommentMarker),
            );
            if (!existingComment) {
              return;
            }

            const currentState = readPreviewCommentState({
              body: existingComment.body ?? "",
              previewCommentMarker,
              previewCommentStateLabel,
            }).currentState;
            const nextState = { ...currentState };

            for (const previewEnvironment of previewEnvironments) {
              const currentEntry = nextState[previewEnvironment.previewEnvironmentAppSlug];
              if (!currentEntry) {
                continue;
              }

              nextState[previewEnvironment.previewEnvironmentAppSlug] = {
                ...currentEntry,
                message:
                  cleanupResult === "success"
                    ? "Preview environment released."
                    : "Preview cleanup failed. The deployment is still assigned for retry/debugging.",
                status: cleanupResult === "success" ? "released" : "cleanup-failed",
                updatedAt: now,
              };
            }

            await github.rest.issues.updateComment({
              ...context.repo,
              body: renderPreviewCommentBody({
                previewCommentMarker,
                previewCommentStateLabel,
                state: nextState,
              }),
              comment_id: existingComment.id,
            });
          },
        ),
      ],
    },
  },
});
