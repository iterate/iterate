import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../../utils/index.ts";
import { checkoutRefExpression, setupRepoWithoutPnpmAction } from "./paths.ts";

export default workflow({
  name: "e2e-tests",
  permissions: {
    contents: "read",
    packages: "write",
    "id-token": "write",
  },
  on: {
    workflow_dispatch: {
      inputs: {
        ref: {
          description: "Git ref to test (branch, tag, or SHA). Leave empty for current branch.",
          required: false,
          type: "string",
          default: "",
        },
      },
    },
  },
  jobs: {
    "build-image": {
      uses: "./.github/workflows/jonasland-sandbox-image.yml",
      secrets: "inherit",
      with: {
        ref: checkoutRefExpression,
      },
    },
    "e2e-tests": {
      needs: ["build-image"],
      "runs-on": "ubuntu-24.04",
      "timeout-minutes": 45,
      steps: [
        ...setupRepoWithoutPnpmAction,
        ...utils.setupDoppler({ config: "dev" }),
        {
          name: "Docker info",
          run: "docker version && docker info",
        },
        {
          name: "Login to Fly registry",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: [
            "set -euo pipefail",
            "doppler run -- sh -c 'echo \"$FLY_API_TOKEN\" | docker login registry.fly.io -u x --password-stdin'",
          ].join("\n"),
        },
        {
          name: "Pull jonasland image",
          env: {
            JONASLAND_SANDBOX_IMAGE: "${{ needs.build-image.outputs.image }}",
          },
          run: 'docker pull "${JONASLAND_SANDBOX_IMAGE}"',
        },
        {
          name: "Typecheck jonasland e2e",
          run: "pnpm --filter ./jonasland/e2e typecheck",
        },
        {
          name: "Run jonasland vitest e2e against Docker",
          env: {
            RUN_JONASLAND_E2E: "true",
            JONASLAND_SANDBOX_IMAGE: "${{ needs.build-image.outputs.image }}",
          },
          run: "pnpm --filter ./jonasland/e2e vitest",
        },
        {
          name: "Upload jonasland e2e test artifacts",
          if: "always()",
          ...uses("actions/upload-artifact@v4", {
            name: "jonasland-e2e-tests-results",
            path: "jonasland/e2e/test-results",
            "retention-days": 7,
          }),
        },
      ],
    },
  },
});
