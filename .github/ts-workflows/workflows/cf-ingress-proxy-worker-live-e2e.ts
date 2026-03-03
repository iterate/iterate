import { workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default workflow({
  name: "CF Ingress Proxy Worker Live E2E",
  permissions: {
    contents: "read",
    deployments: "write",
  },
  on: {
    push: {
      branches: ["main"],
      paths: [
        "apps/cf-ingress-proxy-worker/**",
        ".github/ts-workflows/workflows/cf-ingress-proxy-worker-live-e2e.ts",
        ".github/workflows/cf-ingress-proxy-worker-live-e2e.yml",
      ],
    },
    pull_request: {
      paths: [
        "apps/cf-ingress-proxy-worker/**",
        ".github/ts-workflows/workflows/cf-ingress-proxy-worker-live-e2e.ts",
        ".github/workflows/cf-ingress-proxy-worker-live-e2e.yml",
      ],
    },
    workflow_dispatch: {},
  },
  jobs: {
    "deploy-test": {
      if: "github.event_name == 'workflow_dispatch' || github.event_name == 'push' || github.event.pull_request.head.repo.fork == false",
      ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
      "timeout-minutes": 20,
      env: {
        ALCHEMY_CI_STATE_STORE_CHECK: "false",
      },
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "stg" }),
        {
          name: "Deploy shared ci-ingress worker",
          "working-directory": "apps/cf-ingress-proxy-worker",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            WORKER_NAME: "ci-ingress",
            INGRESS_PROXY_HOSTNAME: "ci-ingress.iterate.com",
          },
          run: [
            "set -euo pipefail",
            "doppler run --config stg -- sh -c 'pnpm run deploy:stg'",
          ].join("\n"),
        },
        {
          name: "Run live Vitest E2E against ci-ingress",
          "working-directory": "apps/cf-ingress-proxy-worker",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: [
            "set -euo pipefail",
            `doppler run --config stg -- sh -c 'pnpm --filter @iterate-com/cf-ingress-proxy-worker test:e2e-live'`,
          ].join("\n"),
        },
      ],
    },
    "deploy-prd": {
      if: "github.event_name == 'push'",
      needs: ["deploy-test"],
      ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "prd" }),
        {
          name: "Deploy apps/cf-ingress-proxy-worker",
          "working-directory": "apps/cf-ingress-proxy-worker",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            WORKER_NAME: "ingress-proxy",
            INGRESS_PROXY_HOSTNAME: "ingress.iterate.com",
          },
          run: "pnpm run deploy:prd",
        },
      ],
    },
  },
});
