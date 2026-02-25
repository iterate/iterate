import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default workflow({
  name: "Jonasland E2E",
  permissions: {
    contents: "read",
  },
  on: {
    push: {
      branches: ["main"],
      paths: [
        "jonasland/e2e/**",
        "jonasland/sandbox/**",
        "services/events-service/**",
        "services/orders-service/**",
        "services/docs-service/**",
        "services/outerbase-service/**",
        "packages/pidnap/**",
        ".github/workflows/jonasland-e2e.yml",
        ".github/ts-workflows/workflows/jonasland-e2e.ts",
      ],
    },
    pull_request: {
      paths: [
        "jonasland/e2e/**",
        "jonasland/sandbox/**",
        "services/events-service/**",
        "services/orders-service/**",
        "services/docs-service/**",
        "services/outerbase-service/**",
        "packages/pidnap/**",
        ".github/workflows/jonasland-e2e.yml",
        ".github/ts-workflows/workflows/jonasland-e2e.ts",
      ],
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
    e2e: {
      ...utils.runsOnDepotUbuntuForContainerThings,
      "timeout-minutes": 45,
      steps: [
        ...utils.getSetupRepo({
          ref: "${{ inputs.ref || github.event.pull_request.head.sha || github.sha }}",
        }),
        {
          name: "Docker info",
          run: "docker version && docker info",
        },
        {
          name: "Build jonasland sandbox image",
          run: "pnpm --filter ./jonasland/sandbox build",
        },
        {
          name: "Typecheck jonasland e2e",
          run: "pnpm --filter ./jonasland/e2e typecheck",
        },
        {
          name: "Run jonasland playwright e2e",
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
      ],
    },
  },
});
