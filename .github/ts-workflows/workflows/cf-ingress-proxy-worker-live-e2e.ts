import { workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default workflow({
  name: "CF Ingress Proxy Worker Live E2E",
  permissions: {
    contents: "read",
    deployments: "write",
  },
  on: {
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
    "deploy-test-teardown": {
      if: "github.event_name == 'workflow_dispatch' || github.event.pull_request.head.repo.fork == false",
      ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
      "timeout-minutes": 20,
      env: {
        ALCHEMY_CI_STATE_STORE_CHECK: "false",
        WORKER_NAME:
          "ipr-e2e-pr${{ github.event.pull_request.number || github.run_id }}-${{ github.run_id }}-${{ github.run_attempt }}",
      },
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "stg" }),
        {
          id: "secrets",
          name: "Generate ephemeral API token",
          run: [
            "set -euo pipefail",
            'token="$(openssl rand -base64 32)"',
            'echo "::add-mask::$token"',
            'echo "api_token=$token" >> "$GITHUB_OUTPUT"',
          ].join("\n"),
        },
        {
          id: "deploy",
          name: "Deploy ephemeral worker with Alchemy",
          "working-directory": "apps/cf-ingress-proxy-worker",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            INGRESS_PROXY_API_TOKEN: "${{ steps.secrets.outputs.api_token }}",
          },
          run: [
            "set -euo pipefail",
            'deploy_log="$(mktemp)"',
            `doppler run --config stg -- sh -c 'WORKER_NAME="$WORKER_NAME" INGRESS_PROXY_API_TOKEN="$INGRESS_PROXY_API_TOKEN" pnpm exec tsx ./alchemy.run.ts cli deploy' | tee "$deploy_log"`,
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
          "working-directory": "apps/cf-ingress-proxy-worker",
          env: {
            INGRESS_PROXY_E2E_BASE_URL: "${{ steps.deploy.outputs.base_url }}",
            INGRESS_PROXY_E2E_API_TOKEN: "${{ steps.secrets.outputs.api_token }}",
          },
          run: [
            "set -euo pipefail",
            "pnpm --filter @iterate-com/cf-ingress-proxy-worker test:e2e-live",
          ].join("\n"),
        },
        {
          name: "Teardown ephemeral worker",
          if: "always()",
          "working-directory": "apps/cf-ingress-proxy-worker",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            INGRESS_PROXY_API_TOKEN: "${{ steps.secrets.outputs.api_token }}",
          },
          run: [
            "set -euo pipefail",
            'if [ -z "${WORKER_NAME:-}" ]; then',
            '  echo "WORKER_NAME not set; skipping teardown"',
            "  exit 0",
            "fi",
            `doppler run --config stg -- sh -c 'WORKER_NAME="$WORKER_NAME" INGRESS_PROXY_API_TOKEN="$INGRESS_PROXY_API_TOKEN" pnpm exec tsx ./alchemy.run.ts cli --destroy' || echo "Teardown failed; check Alchemy state for $WORKER_NAME"`,
          ].join("\n"),
        },
      ],
    },
  },
});
