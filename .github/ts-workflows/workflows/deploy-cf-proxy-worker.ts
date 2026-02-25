import { workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default workflow({
  name: "Deploy CF Proxy Worker",
  permissions: {
    contents: "read",
    deployments: "write",
  },
  on: {
    push: {
      branches: ["main"],
      paths: [
        "apps/cf-proxy-worker/**",
        ".github/ts-workflows/workflows/deploy-cf-proxy-worker.ts",
        ".github/workflows/deploy-cf-proxy-worker.yml",
      ],
    },
    workflow_dispatch: {},
  },
  jobs: {
    deploy: {
      ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "prd" }),
        {
          name: "Deploy apps/cf-proxy-worker",
          "working-directory": "apps/cf-proxy-worker",
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
