import { workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

const workerName = "stream-staging-area-pr-${{ github.event.pull_request.number }}";

export default workflow({
  name: "Streams E2E",
  on: {
    pull_request: {
      types: ["opened", "reopened", "synchronize", "closed"],
      paths: [
        ".github/ts-workflows/workflows/streams-e2e.ts",
        ".github/workflows/streams-e2e.yml",
        "packages/streams/**",
      ],
    },
  },
  permissions: {
    contents: "read",
  },
  concurrency: {
    group: "streams-e2e-pr-${{ github.event.pull_request.number }}",
    "cancel-in-progress": false,
  },
  jobs: {
    "streams-e2e": {
      if: "github.event.action != 'closed'",
      ...utils.runsOnDepotUbuntu,
      env: {
        DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
        WORKER_NAME: workerName,
        WORKER_URL: `https://${workerName}.iterate-dev-preview.workers.dev`,
        STREAM_STAGING_E2E: "true",
      },
      steps: [
        ...utils.getSetupRepo({ ref: "${{ github.event.pull_request.head.sha }}" }),
        utils.installDopplerCli,
        {
          name: "Destroy existing streams worker",
          "working-directory": "packages/streams/example-app",
          run: 'doppler run --project _shared --config prd -- pnpm exec wrangler delete "$WORKER_NAME" --force || true',
        },
        {
          name: "Build streams example app",
          "working-directory": "packages/streams/example-app",
          run: "pnpm build",
        },
        {
          name: "Deploy streams worker",
          "working-directory": "packages/streams/example-app",
          run: 'doppler run --project _shared --config prd -- pnpm exec wrangler deploy --name "$WORKER_NAME"',
        },
        {
          name: "Wait for streams worker",
          run: [
            "for attempt in {1..30}; do",
            "  if node --input-type=module <<'EOF'",
            'const target = new URL("/api/streams/" + encodeURIComponent("/ci-readiness"), process.env.WORKER_URL);',
            'target.protocol = target.protocol === "https:" ? "wss:" : "ws:";',
            "",
            "await new Promise((resolve, reject) => {",
            "  const socket = new WebSocket(target);",
            "  let opened = false;",
            "  const timeout = setTimeout(() => {",
            "    socket.close();",
            '    reject(new Error("Timed out connecting to " + target.href));',
            "  }, 5_000);",
            '  socket.addEventListener("open", () => {',
            "    opened = true;",
            "    clearTimeout(timeout);",
            "    socket.close();",
            "    resolve();",
            "  }, { once: true });",
            '  socket.addEventListener("error", () => {',
            "    clearTimeout(timeout);",
            '    reject(new Error("WebSocket failed for " + target.href));',
            "  }, { once: true });",
            '  socket.addEventListener("close", (event) => {',
            "    if (opened) return;",
            "    clearTimeout(timeout);",
            '    reject(new Error("WebSocket closed before open: " + event.code + " " + event.reason));',
            "  }, { once: true });",
            "});",
            "EOF",
            "  then",
            "    exit 0",
            "  fi",
            '  echo "Worker is not ready yet (attempt $attempt/30)."',
            "  sleep 2",
            "done",
            "",
            'echo "Streams worker did not become ready."',
            "exit 1",
          ].join("\n"),
        },
        {
          name: "Run streams Vitest e2e",
          run: "pnpm --dir packages/streams/example-app vitest",
        },
        {
          name: "Install Playwright browser",
          run: "pnpm --dir packages/streams/example-app exec playwright install --with-deps chromium",
        },
        {
          name: "Run streams Playwright e2e",
          run: "pnpm --dir packages/streams/example-app playwright",
        },
      ],
    },
    cleanup: {
      if: "github.event.action == 'closed'",
      ...utils.runsOnDepotUbuntu,
      env: {
        DOPPLER_TOKEN: "${{ secrets.DOPPLER_TOKEN }}",
        WORKER_NAME: workerName,
      },
      steps: [
        ...utils.setupRepo,
        utils.installDopplerCli,
        {
          name: "Destroy streams worker",
          "working-directory": "packages/streams/example-app",
          run: 'doppler run --project _shared --config prd -- pnpm exec wrangler delete "$WORKER_NAME" --force || true',
        },
      ],
    },
  },
});
