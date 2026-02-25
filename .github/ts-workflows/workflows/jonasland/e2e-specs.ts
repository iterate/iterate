import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../../utils/index.ts";
import { checkoutRefExpression, jonaslandTriggerPaths } from "./paths.ts";

export default workflow({
  name: "e2e-specs",
  permissions: {
    contents: "read",
    packages: "write",
    "id-token": "write",
  },
  on: {
    push: {
      branches: ["main"],
      paths: [...jonaslandTriggerPaths],
    },
    pull_request: {
      paths: [...jonaslandTriggerPaths],
    },
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
      // @ts-expect-error - reusable workflow supports secrets: inherit
      secrets: "inherit",
      with: {
        ref: checkoutRefExpression,
      },
    },
    "e2e-specs": {
      needs: ["build-image"],
      "runs-on": "ubuntu-24.04",
      "timeout-minutes": 45,
      steps: [
        ...utils.getSetupRepo({ ref: checkoutRefExpression }),
        {
          name: "Docker info",
          run: "docker version && docker info",
        },
        {
          name: "Pull jonasland image",
          env: {
            JONASLAND_SANDBOX_IMAGE: "${{ needs.build-image.outputs.image }}",
          },
          run: 'docker pull "${JONASLAND_SANDBOX_IMAGE}"',
        },
        {
          name: "Install Playwright browsers",
          run: "pnpm --filter ./jonasland/e2e exec playwright install --with-deps chromium",
        },
        {
          name: "Typecheck jonasland e2e",
          run: "pnpm --filter ./jonasland/e2e typecheck",
        },
        {
          name: "Run jonasland playwright specs against Docker",
          env: {
            RUN_JONASLAND_E2E: "true",
            JONASLAND_SANDBOX_IMAGE: "${{ needs.build-image.outputs.image }}",
          },
          run: "pnpm --filter ./jonasland/e2e spec:e2e",
        },
        {
          name: "Upload jonasland e2e spec artifacts",
          if: "always()",
          ...uses("actions/upload-artifact@v4", {
            name: "jonasland-e2e-spec-results",
            path: "jonasland/e2e/test-results",
            "retention-days": 7,
          }),
        },
      ],
    },
  },
});
