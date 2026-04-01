import { workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default workflow({
  name: "AI Engineer Workshop",
  on: {
    pull_request: {
      paths: [
        "ai-engineer-workshop/lib/**",
        ".github/ts-workflows/workflows/ai-engineer-workshop.ts",
      ],
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
          name: "Mark package publishable",
          "working-directory": "ai-engineer-workshop/lib",
          run: [
            "node --input-type=module <<'EOF'",
            "import { readFileSync, writeFileSync } from 'node:fs';",
            "const packageJsonPath = new URL('package.json', `file://${process.cwd()}/`);",
            "const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));",
            "pkg.private = false;",
            "writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\\n`);",
            "EOF",
          ].join("\n"),
        },
        {
          name: "Publish preview package",
          run: "pnpx pkg-pr-new publish --pnpm './ai-engineer-workshop/lib'",
        },
      ],
    },
  },
});
