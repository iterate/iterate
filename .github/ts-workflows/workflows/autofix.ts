import { workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default workflow({
  name: "autofix.ci",
  on: {
    pull_request: {},
    push: {
      branches: ["main", "**/*autofix*", "*autofix*"],
    },
  },
  jobs: {
    autofix: {
      ...utils.runsOnDepotImage,
      steps: [
        {
          name: "Checkout code",
          uses: "actions/checkout@v4",
          // Keep the baked node_modules so the install below is near-instant.
          with: { clean: false },
        },
        {
          // Deliberately NOT --frozen: autofix's job is to update the lockfile.
          // --prefer-offline reuses the baked pnpm store.
          name: "install and update lockfile",
          run: "pnpm install --no-frozen-lockfile --prefer-offline",
        },
        {
          name: "fix lint issues",
          run: "pnpm exec oxlint . --fix --threads 1",
        },
        {
          name: "fix format issues",
          run: "pnpm run format",
        },
        {
          name: "revert changes to workflows", // autofix.ci can't update .github/workflows; generated yaml is owned by the generator
          run: "git checkout .github/workflows .depot/workflows",
          if: "always()",
        },
        {
          run: "git diff",
          if: "always()",
        },
        {
          name: "apply fixes",
          if: "always()",
          uses: "autofix-ci/action@635ffb0c9798bd160680f18fd73371e355b85f27",
        },
      ],
    },
  },
});
