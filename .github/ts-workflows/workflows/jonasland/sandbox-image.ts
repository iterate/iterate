import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../../utils/index.ts";
import { checkoutRefExpression } from "./paths.ts";

export default workflow({
  name: "jonasland-sandbox-image",
  permissions: {
    contents: "read",
    packages: "write",
    "id-token": "write",
  },
  on: {
    workflow_call: {
      inputs: {
        ref: {
          description: "Git ref to build (branch, tag, or SHA). Leave empty to use caller SHA.",
          required: false,
          type: "string",
          default: "",
        },
      },
      outputs: {
        image: {
          description: "Pushed jonasland sandbox image ref",
          value: "${{ jobs.build.outputs.image }}",
        },
        git_sha: {
          description: "Git SHA that was built",
          value: "${{ jobs.build.outputs.git_sha }}",
        },
      },
    },
    workflow_dispatch: {
      inputs: {
        ref: {
          description: "Git ref to build (branch, tag, or SHA). Leave empty for current branch.",
          required: false,
          type: "string",
          default: "",
        },
      },
    },
  },
  jobs: {
    build: {
      ...utils.runsOnDepotUbuntuForContainerThings,
      outputs: {
        image: "${{ steps.image_meta.outputs.image }}",
        git_sha: "${{ steps.image_meta.outputs.git_sha }}",
      },
      steps: [
        ...utils.getSetupRepo({ ref: checkoutRefExpression }),
        ...utils.setupDepot,
        {
          id: "image_meta",
          name: "Compute image metadata",
          env: {
            REGISTRY_IMAGE: "ghcr.io/${{ github.repository_owner }}/jonasland-sandbox",
          },
          run: [
            "set -euo pipefail",
            'git_sha="$(git rev-parse HEAD)"',
            'short_sha="$(git rev-parse --short=7 HEAD)"',
            'image="${REGISTRY_IMAGE}:sha-${short_sha}"',
            'echo "git_sha=${git_sha}" >> "$GITHUB_OUTPUT"',
            'echo "image=${image}" >> "$GITHUB_OUTPUT"',
          ].join("\n"),
        },
        {
          name: "Login to GHCR",
          ...uses("docker/login-action@v3", {
            registry: "ghcr.io",
            username: "${{ github.actor }}",
            password: "${{ secrets.GITHUB_TOKEN }}",
          }),
        },
        {
          name: "Build and push jonasland image (Depot)",
          env: {
            GIT_SHA: "${{ steps.image_meta.outputs.git_sha }}",
            IMAGE: "${{ steps.image_meta.outputs.image }}",
          },
          run: [
            "set -euo pipefail",
            "depot build \\",
            "  --platform linux/amd64,linux/arm64 \\",
            "  -f jonasland/sandbox/Dockerfile \\",
            "  --build-arg GIT_SHA=${GIT_SHA} \\",
            "  -t ${IMAGE} \\",
            "  --push \\",
            "  .",
          ].join("\n"),
        },
      ],
    },
  },
});
