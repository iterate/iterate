import { workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default workflow({
  name: "AI Engineer Workshop",
  on: {
    pull_request: {
      paths: ["ai-engineer-workshop/**", ".github/ts-workflows/workflows/ai-engineer-workshop.ts"],
    },
    push: {
      branches: ["main"],
      paths: ["ai-engineer-workshop/**", ".github/ts-workflows/workflows/ai-engineer-workshop.ts"],
    },
    workflow_dispatch: {},
  },
  jobs: {
    publish: {
      ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
      steps: [
        ...utils.setupRepo,
        {
          name: "Typecheck package",
          run: "pnpm --filter ai-engineer-workshop typecheck",
        },
        {
          name: "Build package",
          run: "pnpm --filter ai-engineer-workshop build",
        },
        {
          name: "Publish preview package",
          run: "pnpx pkg-pr-new publish --pnpm './ai-engineer-workshop'",
        },
      ],
    },
  },
});
