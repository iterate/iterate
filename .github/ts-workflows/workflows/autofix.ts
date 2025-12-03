import dedent from "dedent";
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
    artifact: {
      ...utils.runsOnUbuntuLatest,
      steps: [
        { run: `mkdir website && echo '<i>hi</i>' > website/foo.html` },
        {
          uses: "actions/upload-artifact@v4",
          with: { name: "website", path: "website" },
        },
      ],
    },
    autofix: {
      ...utils.runsOn,
      steps: [
        {
          name: "Checkout code",
          uses: "actions/checkout@v4",
        },
        {
          name: "Setup Pnpm",
          uses: "pnpm/action-setup@v4",
        },
        {
          name: "Setup Node",
          uses: "actions/setup-node@v4",
          with: {
            "node-version": 24,
            cache: "pnpm",
          },
        },
        {
          name: "install and update lockfile",
          run: "pnpm install --no-frozen-lockfile",
        },
        {
          name: "disable check annotations",
          run: dedent`
            echo "::remove-matcher owner=eslint-compact::"
            echo "::remove-matcher owner=eslint-stylish::"
          `,
        },
        {
          name: "fix lint issues",
          run: "pnpm run lint --fix --max-warnings=-1",
        },
        {
          name: "fix format issues",
          run: "pnpm run format",
        },
        {
          name: "revert changes to workflows", // autofix.ci can't update this folder
          run: "git checkout .github/workflows",
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
