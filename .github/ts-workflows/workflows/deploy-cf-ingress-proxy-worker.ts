import { workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default workflow({
  name: "Deploy CF Ingress Proxy Worker",
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
          name: "Deploy apps/cf-ingress-proxy-worker",
          "working-directory": "apps/cf-ingress-proxy-worker",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            APP_STAGE: "prd",
            WORKER_NAME: "ingress-proxy",
            INGRESS_PROXY_HOSTNAME: "ingress.iterate.com",
          },
          run: "pnpm run deploy:prd",
        },
      ],
    },
  },
});
