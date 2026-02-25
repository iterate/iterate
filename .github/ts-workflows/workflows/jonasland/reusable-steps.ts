import { uses, type Step } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../../utils/index.ts";

export const jonaslandImageMetadataStepId = "jonasland_image_meta";

export function getBuildJonaslandImageWithDepotAndPushSteps(): Step[] {
  return [
    ...utils.setupDepot,
    {
      id: jonaslandImageMetadataStepId,
      name: "Compute jonasland image tags",
      env: {
        REGISTRY_IMAGE: "ghcr.io/${{ github.repository_owner }}/jonasland-sandbox",
      },
      run: [
        "set -euo pipefail",
        'git_sha="$(git rev-parse HEAD)"',
        'short_sha="$(git rev-parse --short=7 HEAD)"',
        'local_image="jonasland-sandbox:ci-${short_sha}"',
        'registry_image_ref="${REGISTRY_IMAGE}:sha-${short_sha}"',
        'echo "git_sha=${git_sha}" >> "$GITHUB_OUTPUT"',
        'echo "short_sha=${short_sha}" >> "$GITHUB_OUTPUT"',
        'echo "local_image=${local_image}" >> "$GITHUB_OUTPUT"',
        'echo "registry_image_ref=${registry_image_ref}" >> "$GITHUB_OUTPUT"',
      ].join("\n"),
    },
    {
      name: "Login to GHCR",
      if: "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository",
      ...uses("docker/login-action@v3", {
        registry: "ghcr.io",
        username: "${{ github.actor }}",
        password: "${{ secrets.GITHUB_TOKEN }}",
      }),
    },
    {
      name: "Build and push jonasland image (Depot)",
      if: "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository",
      env: {
        GIT_SHA: "${{ steps.jonasland_image_meta.outputs.git_sha }}",
        REGISTRY_IMAGE_REF: "${{ steps.jonasland_image_meta.outputs.registry_image_ref }}",
      },
      run: [
        "set -euo pipefail",
        "depot build \\",
        "  --platform linux/amd64 \\",
        "  -f jonasland/sandbox/Dockerfile \\",
        "  --build-arg GIT_SHA=${GIT_SHA} \\",
        "  -t ${REGISTRY_IMAGE_REF} \\",
        "  --push \\",
        "  .",
      ].join("\n"),
    },
    {
      name: "Build and load jonasland image for docker e2e (Depot)",
      env: {
        GIT_SHA: "${{ steps.jonasland_image_meta.outputs.git_sha }}",
        LOCAL_IMAGE: "${{ steps.jonasland_image_meta.outputs.local_image }}",
      },
      run: [
        "set -euo pipefail",
        "depot build \\",
        "  --platform linux/amd64 \\",
        "  -f jonasland/sandbox/Dockerfile \\",
        "  --build-arg GIT_SHA=${GIT_SHA} \\",
        "  -t ${LOCAL_IMAGE} \\",
        "  --load \\",
        "  .",
      ].join("\n"),
    },
  ];
}

export function getRunJonaslandE2eAgainstDockerSteps(): Step[] {
  return [
    {
      name: "Install Playwright browsers",
      run: "pnpm --filter ./jonasland/e2e exec playwright install --with-deps chromium",
    },
    {
      name: "Typecheck jonasland e2e",
      run: "pnpm --filter ./jonasland/e2e typecheck",
    },
    {
      name: "Run jonasland playwright e2e against Docker",
      env: {
        RUN_JONASLAND_E2E: "true",
        JONASLAND_SANDBOX_IMAGE: "${{ steps.jonasland_image_meta.outputs.local_image }}",
      },
      run: "pnpm --filter ./jonasland/e2e spec:e2e",
    },
    {
      name: "Upload jonasland e2e artifacts",
      if: "always()",
      ...uses("actions/upload-artifact@v4", {
        name: "jonasland-e2e-results",
        path: "jonasland/e2e/test-results",
        "retention-days": 7,
      }),
    },
  ];
}
