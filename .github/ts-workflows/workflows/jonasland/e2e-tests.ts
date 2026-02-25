import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../../utils/index.ts";
import { checkoutRefExpression, jonaslandTriggerPaths } from "./paths.ts";

const setupRepoWithoutPnpmAction = [
  {
    name: "Checkout code",
    ...uses("actions/checkout@v4", {
      ref: checkoutRefExpression,
    }),
  },
  {
    name: "Setup Node",
    ...uses("actions/setup-node@v4", {
      "node-version": 24,
    }),
  },
  {
    name: "Install pnpm",
    run: [
      "set -euo pipefail",
      "export PNPM_VERSION=10.24.0",
      "curl -fsSL https://get.pnpm.io/install.sh | sh -",
      'echo "PNPM_HOME=$HOME/.local/share/pnpm" >> "$GITHUB_ENV"',
      'echo "$HOME/.local/share/pnpm" >> "$GITHUB_PATH"',
      "$HOME/.local/share/pnpm/pnpm --version",
    ].join("\n"),
  },
  {
    name: "Install dependencies",
    run: "pnpm install",
  },
] as const;

export default workflow({
  name: "e2e-tests",
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
          run: "pnpm --filter ./jonasland/e2e exec vitest run",
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
