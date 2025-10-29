import dedent from "dedent";
import { workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default workflow({
  name: "Publish to pkg.pr.new",
  on: {
    push: {
      branches: ["main"],
    },
    pull_request: {},
    workflow_dispatch: {},
  },
  permissions: {
    contents: "read",
  },
  jobs: {
    "pkg-pr": {
      ...utils.runsOn,
      steps: [
        {
          name: "Checkout code",
          uses: "actions/checkout@v4",
        },
        {
          name: "Setup Pnpm",
          uses: "pnpm/action-setup@v4",
        },
        {
          name: "Setup Node",
          uses: "actions/setup-node@v4",
          with: {
            "node-version": 24,
            cache: "pnpm",
          },
        },
        {
          name: "Install dependencies",
          run: "pnpm install",
        },
        {
          name: "check types/exports",
          run: "pnpx --package @arethetypeswrong/cli attw --pack --profile esm-only",
          "working-directory": "packages/sdk",
        },
        {
          name: "Publish SDK package with retries",
          uses: "nick-fields/retry@v3",
          with: {
            timeout_seconds: 30,
            max_attempts: 3,
            retry_wait_seconds: 5,
            command: "pnpx pkg-pr-new publish --comment=off --bin --pnpm ./packages/sdk",
          },
        },
      ],
    },
    "sync-estate-template-to-repo": {
      "runs-on": "ubuntu-24.04",
      needs: "pkg-pr",
      if: "github.event_name == 'push' && github.ref == 'refs/heads/main' || github.event_name == 'workflow_dispatch'",
      steps: [
        {
          name: "Checkout source repo",
          uses: "actions/checkout@v4",
          with: {
            "fetch-depth": 0,
          },
        },
        {
          name: "Checkout target repo",
          uses: "actions/checkout@v4",
          with: {
            repository: "iterate-com/estate-template",
            token: "${{ secrets.TEMPLATE_ESTATE_SYNC_TOKEN }}",
            path: "target-repo",
          },
        },
        {
          name: "Sync files",
          run: dedent`
            # Remove all files from target repo except .git
            find target-repo -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +

            # Copy all files from estates/template to target repo
            cp -r estates/template/* target-repo/
            cp -r estates/template/.gitignore target-repo/ 2>/dev/null || true
          `,
        },
        {
          name: "Update SDK dependency to pkg.pr.new",
          run: dedent`
            cd target-repo

            COMMIT_HASH="\${{ github.sha }}"
            echo "Using commit hash: $COMMIT_HASH"

            # Replace workspace:* with pkg.pr.new URL
            sed -i "s|\"@iterate-com/sdk\": \"workspace:\*\"|\"@iterate-com/sdk\": \"https://pkg.pr.new/iterate/iterate/@iterate-com/sdk@$COMMIT_HASH\"|g" package.json

            # Show the change
            echo "Updated package.json:"
            cat package.json
          `,
        },
        {
          name: "Commit and push changes",
          run: dedent`
            cd target-repo

            COMMIT_HASH="\${{ github.sha }}"

            git config user.name "github-actions[bot]"
            git config user.email "github-actions[bot]@users.noreply.github.com"

            git add -A

            # Only commit if there are changes
            if git diff --staged --quiet; then
              echo "No changes to sync"
            else
              git commit -m "Sync from iterate/iterate@$COMMIT_HASH"
              git push
            fi
          `,
        },
      ],
    },
  },
});
