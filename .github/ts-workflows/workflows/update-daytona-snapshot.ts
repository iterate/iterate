import type { Workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default {
  name: "Update Daytona Snapshot",
  on: {
    workflow_dispatch: {}, // Manual trigger
    push: {
      branches: ["main"],
      paths: ["apps/os2/sandbox/Dockerfile", "apps/os2/sandbox/entry.ts", "pnpm-lock.yaml"],
    },
  },
  permissions: {
    contents: "read",
  },
  jobs: {
    "update-snapshot": {
      name: "Update Daytona Snapshot",
      "timeout-minutes": 30,
      ...utils.runsOn,
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "stg" }),
        {
          name: "Build and push Daytona snapshot",
          env: {
            DAYTONA_API_KEY: "${{ secrets.DAYTONA_API_KEY }}",
          },
          run: "pnpm tsx apps/os2/sandbox/snapshot.ts",
        },
      ],
    },
  },
} satisfies Workflow;
