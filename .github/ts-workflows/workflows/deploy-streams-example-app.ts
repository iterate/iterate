import { workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

const workerName = "streams-example-app";

export default workflow({
  name: "Deploy Streams Example App",
  on: {
    push: {
      branches: ["main"],
      paths: [
        ".github/ts-workflows/workflows/deploy-streams-example-app.ts",
        ".github/workflows/deploy-streams-example-app.yml",
        "packages/streams/**",
      ],
    },
  },
  permissions: {
    contents: "read",
  },
  concurrency: {
    group: "streams-example-app-prd",
    "cancel-in-progress": true,
  },
  jobs: {
    deploy: {
      ...utils.runsOnDepotUbuntu,
      env: {
        DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
        WORKER_NAME: workerName,
      },
      steps: [
        ...utils.setupRepo,
        utils.installDopplerCli,
        {
          name: "Build streams example app",
          "working-directory": "packages/streams/example-app",
          run: "pnpm build",
        },
        {
          name: "Deploy streams example app",
          "working-directory": "packages/streams/example-app",
          run: 'doppler run --project _shared --config prd -- pnpm exec wrangler deploy --name "$WORKER_NAME"',
        },
      ],
    },
  },
});
