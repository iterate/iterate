import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default workflow({
  name: "Local Docker Tests",
  on: {
    push: {
      branches: ["main"],
      paths: ["apps/os/sandbox/**", "apps/daemon/**", ".github/workflows/local-docker-test.yml"],
    },
    pull_request: {
      paths: ["apps/os/sandbox/**", "apps/daemon/**", ".github/workflows/local-docker-test.yml"],
    },
    workflow_dispatch: {},
  },
  jobs: {
    test: {
      ...utils.runsOn,
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "dev" }),
        {
          name: "Run Local Docker Tests",
          env: {
            RUN_LOCAL_DOCKER_TESTS: "true",
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: "pnpm os snapshot:local-docker:test",
        },
        {
          name: "Upload test results",
          if: "failure()",
          ...uses("actions/upload-artifact@v4", {
            name: "local-docker-test-logs",
            path: "apps/os/sandbox/test-results",
            "retention-days": 7,
          }),
        },
      ],
    },
  },
});
