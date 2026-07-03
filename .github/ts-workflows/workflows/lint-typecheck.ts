import { workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default workflow({
  name: "Lint and Typecheck",
  on: {
    push: {
      branches: ["main"],
    },
    pull_request: {},
    workflow_dispatch: {},
  },
  jobs: {
    "lint-typecheck": {
      ...utils.runsOnDepotImage,
      steps: [
        ...utils.setupFromImage(),
        {
          name: "Run Lint",
          run: "pnpm exec oxlint . --threads 1 --deny-warnings",
        },
        {
          name: "Run Typecheck",
          run: "pnpm typecheck",
        },
        {
          name: "Run Knip",
          run: "pnpm knip",
        },
      ],
    },
  },
});
