import type { Workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default {
  name: "Actionlint",
  on: { pull_request: {} },
  jobs: {
    run: {
      ...utils.runsOnUbuntuLatest,
      steps: [
        utils.checkoutStep,
        {
          name: "Run reviewdog/action-actionlint",
          uses: "reviewdog/action-actionlint@v1",
          with: {
            reporter: "github-pr-check",
            fail_level: "any",
          },
        },
      ],
    },
  },
} satisfies Workflow;
