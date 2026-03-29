import dedent from "dedent";
import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default workflow({
  name: "Integration",
  on: {
    push: {
      branches: ["main"],
    },
    pull_request: {},
  },
  jobs: {
    integration: {
      ...utils.runsOnDepotUbuntuForContainerThings,
      steps: [
        ...utils.setupRepo,
        { run: "pnpm docker:up" },
        ...utils.setupDoppler({ config: "dev" }),
        {
          name: "Create test results folder",
          run: "mkdir -p test-results",
        },
        {
          name: "Start dev server",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: "nohup doppler run -- pnpm dev > test-results/pnpm-dev.log 2>&1 &",
        },
        {
          name: "Wait for dev server",
          run: dedent`
            for i in $(seq 1 180); do
              if curl -fsS http://local.iterate.com:5173/api/orpc/testing/health >/dev/null; then
                exit 0
              fi
              sleep 1
            done

            tail -100 test-results/pnpm-dev.log || true
            exit 1
          `,
        },
        {
          name: "Run integration tests",
          run: dedent`
            set -o pipefail
            mkdir -p test-results/vitest-report
            cd apps/os
            doppler run -- pnpm exec vitest run --config vitest.integration.config.ts --reporter=default --reporter=html --outputFile.html=../../test-results/vitest-report/index.html | tee ../../test-results/vitest.txt
          `,
        },
        {
          name: "Upload integration artifacts",
          if: "failure()",
          ...uses("actions/upload-artifact@v4", {
            name: "integration-results",
            path: "test-results",
            "retention-days": 7,
          }),
        },
      ],
    },
  },
});
