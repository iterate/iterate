import type { Workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default {
  name: "Daytona Snapshot Test",
  on: {
    workflow_dispatch: {}, // Manual trigger
    push: {
      branches: ["main"],
      paths: [
        "apps/os/sandbox/**",
        "apps/daemon/**",
        "pnpm-lock.yaml",
        ".github/workflows/update-daytona-snapshot.yml",
      ],
    },
  },
  permissions: {
    contents: "read",
  },
  jobs: {
    "build-snapshot": {
      name: "Build Daytona Snapshot",
      "timeout-minutes": 30,
      ...utils.runsOn,
      outputs: {
        snapshot_name: "${{ steps.build.outputs.snapshot_name }}",
      },
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "prd" }),
        {
          id: "build",
          name: "Build and push Daytona snapshot",
          env: {
            SANDBOX_ITERATE_REPO_REF: "main",
          },
          run: [
            "OUTPUT=$(pnpm os snapshot:daytona:prd 2>&1)",
            'echo "$OUTPUT"',
            'SNAPSHOT_NAME=$(echo "$OUTPUT" | grep -oP "Creating snapshot: \\K(prd--\\d{8}-\\d{6})")',
            'echo "snapshot_name=$SNAPSHOT_NAME" >> $GITHUB_OUTPUT',
          ].join("\n"),
        },
      ],
    },
    test: {
      name: "Daytona Test",
      needs: "build-snapshot",
      "timeout-minutes": 15,
      ...utils.runsOn,
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "prd" }),
        {
          name: "Install cloudflared",
          run: [
            "curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb",
            "sudo dpkg -i cloudflared.deb",
          ].join("\n"),
        },
        {
          name: "Run Daytona Test",
          env: {
            RUN_DAYTONA_TESTS: "true",
            DAYTONA_SNAPSHOT_NAME: "${{ needs.build-snapshot.outputs.snapshot_name }}",
          },
          run: "pnpm os snapshot:daytona:test",
        },
      ],
    },
  },
} satisfies Workflow;
