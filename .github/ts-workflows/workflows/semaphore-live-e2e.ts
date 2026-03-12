import { workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default workflow({
  name: "Semaphore Live E2E",
  permissions: {
    contents: "read",
    deployments: "write",
  },
  on: {
    push: {
      branches: ["main"],
      paths: [
        "apps/semaphore/**",
        ".github/ts-workflows/workflows/semaphore-live-e2e.ts",
        ".github/workflows/semaphore-live-e2e.yml",
      ],
    },
    pull_request: {
      paths: [
        "apps/semaphore/**",
        ".github/ts-workflows/workflows/semaphore-live-e2e.ts",
        ".github/workflows/semaphore-live-e2e.yml",
      ],
    },
    workflow_dispatch: {},
  },
  jobs: {
    "deploy-test-teardown": {
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
          name: "Set ephemeral worker name",
          run: [
            "set -euo pipefail",
            'echo "WORKER_NAME=semaphore-pr-${{ github.event.pull_request.number || github.run_id }}-${{ github.run_id }}-${{ github.run_attempt }}" >> "$GITHUB_ENV"',
          ].join("\n"),
        },
        {
          id: "shared-secret",
          name: "Generate shared secret",
          run: [
            "set -euo pipefail",
            'shared_secret="$(openssl rand -hex 32)"',
            'echo "::add-mask::$shared_secret"',
            'echo "shared_secret=$shared_secret" >> "$GITHUB_OUTPUT"',
          ].join("\n"),
        },
        {
          id: "deploy",
          name: "Deploy ephemeral worker with Alchemy",
          "working-directory": "apps/semaphore",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            SEMAPHORE_API_TOKEN: "${{ steps.shared-secret.outputs.shared_secret }}",
          },
          run: [
            "set -euo pipefail",
            'deploy_log="$(mktemp)"',
            `doppler run --config stg --preserve-env="WORKER_NAME,SEMAPHORE_API_TOKEN" -- sh -c 'WORKER_NAME="$WORKER_NAME" SEMAPHORE_API_TOKEN="$SEMAPHORE_API_TOKEN" pnpm exec tsx ./alchemy.run.ts cli deploy --stage ci' | tee "$deploy_log"`,
            'base_url="$(grep -Eo \'https://[^[:space:]]+\' "$deploy_log" | tail -n 1)"',
            'base_url="${base_url%/}"',
            'if [ -z "$base_url" ]; then',
            '  echo "Failed to parse deployed worker URL from deploy logs"',
            "  exit 1",
            "fi",
            'echo "base_url=$base_url" >> "$GITHUB_OUTPUT"',
            'echo "Deployed ephemeral worker at: $base_url"',
          ].join("\n"),
        },
        {
          name: "Run live Vitest E2E against ephemeral deployment",
          "working-directory": "apps/semaphore",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            SEMAPHORE_E2E_BASE_URL: "${{ steps.deploy.outputs.base_url }}",
            SEMAPHORE_E2E_API_TOKEN: "${{ steps.shared-secret.outputs.shared_secret }}",
          },
          run: [
            "set -euo pipefail",
            `doppler run --config stg --preserve-env="SEMAPHORE_E2E_BASE_URL,SEMAPHORE_E2E_API_TOKEN" -- sh -c 'pnpm --filter @iterate-com/semaphore test:e2e-live'`,
          ].join("\n"),
        },
        {
          name: "Teardown ephemeral worker",
          if: "always()",
          "working-directory": "apps/semaphore",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            SEMAPHORE_API_TOKEN: "${{ steps.shared-secret.outputs.shared_secret }}",
          },
          run: [
            "set -euo pipefail",
            'if [ -z "${WORKER_NAME:-}" ]; then',
            '  echo "WORKER_NAME not set; skipping teardown"',
            "  exit 0",
            "fi",
            `doppler run --config stg --preserve-env="WORKER_NAME,SEMAPHORE_API_TOKEN" -- sh -c 'WORKER_NAME="$WORKER_NAME" SEMAPHORE_API_TOKEN="$SEMAPHORE_API_TOKEN" pnpm exec tsx ./alchemy.run.ts cli --destroy --stage ci' || echo "Teardown command failed; check Alchemy state manually for $WORKER_NAME"`,
          ].join("\n"),
        },
      ],
    },
    "deploy-prd": {
      if: "github.event_name == 'push'",
      needs: ["deploy-test-teardown"],
      ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "prd" }),
        {
          name: "Deploy apps/semaphore",
          "working-directory": "apps/semaphore",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: "pnpm run deploy:prd",
        },
      ],
    },
  },
});
