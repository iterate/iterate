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
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "stg" }),
        {
          name: "Set ephemeral stage name",
          run: [
            "set -euo pipefail",
            'echo "APP_STAGE=pr-${{ github.event.pull_request.number || github.run_id }}-${{ github.run_id }}-${{ github.run_attempt }}" >> "$GITHUB_ENV"',
          ].join("\n"),
        },
        {
          id: "deploy",
          name: "Deploy ephemeral worker with Alchemy",
          "working-directory": "apps/cf-ingress-proxy-worker",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: [
            "set -euo pipefail",
            'deploy_log="$(mktemp)"',
            `doppler run --config stg -- sh -c 'APP_STAGE="$APP_STAGE" tsx ./alchemy.run.ts cli deploy --stage "$APP_STAGE"' | tee "$deploy_log"`,
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
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
            INGRESS_PROXY_E2E_BASE_URL: "${{ steps.deploy.outputs.base_url }}",
          },
          run: [
            "set -euo pipefail",
            `doppler run --config stg -- sh -c 'export INGRESS_PROXY_E2E_BASE_URL="$INGRESS_PROXY_E2E_BASE_URL"; export INGRESS_PROXY_E2E_API_TOKEN="\${INGRESS_PROXY_E2E_API_TOKEN:-\${INGRESS_PROXY_API_TOKEN:-$CF_PROXY_WORKER_API_TOKEN}}"; pnpm --filter @iterate-com/cf-ingress-proxy-worker test:e2e-live'`,
          ].join("\n"),
        },
        {
          name: "Teardown ephemeral worker",
          if: "always()",
          "working-directory": "apps/cf-ingress-proxy-worker",
          env: {
            DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
          },
          run: [
            "set -euo pipefail",
            'if [ -z "${APP_STAGE:-}" ]; then',
            '  echo "APP_STAGE not set; skipping teardown"',
            "  exit 0",
            "fi",
            `doppler run --config stg -- sh -c 'tsx ./alchemy.run.ts cli --destroy --stage "$APP_STAGE"' || echo "Teardown command failed; check Alchemy state manually for $APP_STAGE"`,
          ].join("\n"),
        },
      ],
    },
  },
});
