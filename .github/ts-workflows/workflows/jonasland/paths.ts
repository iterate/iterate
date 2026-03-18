import { uses } from "@jlarky/gha-ts/workflow-types";

export const checkoutRefExpression =
  "${{ inputs.ref || github.event.pull_request.head.sha || github.sha }}";

export const setupRepoWithoutPnpmAction = [
  {
    name: "Checkout code",
    ...uses("actions/checkout@v4", {
      ref: checkoutRefExpression,
    }),
  },
  {
    name: "Setup Node",
    ...uses("actions/setup-node@v4", {
      "node-version": 24,
    }),
  },
  {
    name: "Install pnpm",
    run: [
      "set -euo pipefail",
      "export PNPM_VERSION=10.24.0",
      'for i in 1 2 3; do curl -fsSL https://get.pnpm.io/install.sh | sh - && break; if [ "$i" -eq 3 ]; then echo "Failed to install pnpm after $i attempts"; exit 1; fi; echo "Attempt $i failed, retrying in 5s..."; sleep 5; done',
      'echo "PNPM_HOME=$HOME/.local/share/pnpm" >> "$GITHUB_ENV"',
      'echo "$HOME/.local/share/pnpm" >> "$GITHUB_PATH"',
      "$HOME/.local/share/pnpm/pnpm --version",
    ].join("\n"),
  },
  {
    name: "Install dependencies",
    run: "pnpm install",
  },
] as const;
