import { workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../../utils/index.ts";
import {
  getBuildJonaslandImageWithDepotAndPushSteps,
  getRunJonaslandE2eAgainstDockerSteps,
} from "./reusable-steps.ts";

export default workflow({
  name: "Jonasland E2E",
  permissions: {
    contents: "read",
    packages: "write",
    "id-token": "write",
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
        ".github/ts-workflows/workflows/jonasland/**",
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
        ".github/ts-workflows/workflows/jonasland/**",
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
        ...getBuildJonaslandImageWithDepotAndPushSteps(),
        ...getRunJonaslandE2eAgainstDockerSteps(),
      ],
    },
  },
});
