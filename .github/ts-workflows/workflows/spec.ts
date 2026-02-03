import { workflow, uses } from "@jlarky/gha-ts/workflow-types";
import dedent from "dedent";
import * as utils from "../utils/index.ts";

export default workflow({
  name: "specs",
  on: {
    push: {},
  },
  env: {
    SLACK_CLIENT_ID: "fake123",
    DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
  },
  jobs: {
    specs: {
      ...utils.runsOn,
      steps: [
        { uses: "actions/checkout@v4" },
        { uses: "pnpm/action-setup@v4" },
        {
          uses: "actions/setup-node@v4",
          with: {
            "node-version": 24,
            cache: "pnpm",
          },
        },
        { run: "pnpm docker:up" },
        { run: "pnpm install" },
        { uses: "dopplerhq/cli-action@v2" },
        {
          name: "Setup Doppler",
          run: "doppler setup --project os --config dev_test",
        },
        {
          name: "Install Playwright browsers",
          run: "pnpm exec playwright install && pnpm exec playwright install-deps",
        },
        {
          name: "Run specs",
          run: dedent`
            set -o pipefail
            mkdir -p test-results
            # tee everything to a log file but filter out WebServer logs which are noisy
            pnpm spec | tee test-results/spec.txt | grep -v WebServer
          `,
        },
        {
          name: "upload logs",
          if: "always()",
          ...uses("actions/upload-artifact@v4", {
            name: "spec-results",
            path: "test-results",
          }),
        },
      ],
    },
    "daytona-sync-spec": {
      ...utils.runsOn,
      if: "github.ref == 'refs/heads/main' || contains(github.event.head_commit.message, '[daytona-sync]')",
      steps: [
        { uses: "actions/checkout@v4" },
        { uses: "pnpm/action-setup@v4" },
        {
          uses: "actions/setup-node@v4",
          with: {
            "node-version": 24,
            cache: "pnpm",
          },
        },
        { run: "pnpm install" },
        { uses: "dopplerhq/cli-action@v2" },
        {
          name: "Setup Doppler",
          run: "doppler setup --project os --config dev",
        },
        {
          name: "Install Playwright browsers",
          run: "pnpm exec playwright install && pnpm exec playwright install-deps",
        },
        {
          name: "Run Daytona sync spec",
          id: "daytona-sync",
          run: dedent`
            set -o pipefail
            mkdir -p test-results
            RUN_DAYTONA_SYNC_SPEC=1 pnpm spec daytona-sync 2>&1 | tee test-results/daytona-sync.txt | grep -v WebServer || echo "DAYTONA_SYNC_FAILED=true" >> $GITHUB_ENV
          `,
          "continue-on-error": true,
        },
        {
          name: "upload logs",
          if: "always()",
          ...uses("actions/upload-artifact@v4", {
            name: "daytona-sync-results",
            path: "test-results",
          }),
        },
        {
          name: "Comment on commit if failed",
          if: "env.DAYTONA_SYNC_FAILED == 'true'",
          ...uses("actions/github-script@v7", {
            script: dedent`
              const fs = require('fs');
              let logContent = '';
              try {
                logContent = fs.readFileSync('test-results/daytona-sync.txt', 'utf8');
                // Get last 100 lines
                const lines = logContent.split('\\n');
                logContent = lines.slice(-100).join('\\n');
              } catch (e) {
                logContent = 'Could not read log file';
              }

              await github.rest.repos.createCommitComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                commit_sha: context.sha,
                body: \`## Daytona Sync Spec Failed

              The daytona-sync E2E test failed. This test verifies that iterate repo syncing works on Daytona machines.

              <details>
              <summary>Last 100 lines of output</summary>

              \\\`\\\`\\\`
              \${logContent}
              \\\`\\\`\\\`
              </details>

              [View full logs](https://github.com/\${context.repo.owner}/\${context.repo.repo}/actions/runs/\${context.runId})\`
              });
            `,
          }),
        },
      ],
    },
  },
});
