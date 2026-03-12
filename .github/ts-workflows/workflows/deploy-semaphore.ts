import { workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default workflow({
  name: "Deploy Semaphore",
  permissions: {
    contents: "read",
    deployments: "write",
  },
  on: {
    workflow_dispatch: {},
  },
  jobs: {
    deploy: {
      ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "prd" }),
        {
          name: "Deploy apps/semaphore",
          "working-directory": "apps/semaphore",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            APP_STAGE: "prd",
          },
          run: "pnpm run deploy:prd",
        },
      ],
    },
  },
});
