import { workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default workflow({
  name: "Deploy Auth Worker",
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
          name: "Deploy apps/auth",
          "working-directory": "apps/auth",
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
