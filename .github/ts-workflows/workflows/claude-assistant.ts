import dedent from "dedent";
import { workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default workflow({
  name: "Claude Assistant",
  on: {
    issue_comment: {
      types: ["created"],
    },
    pull_request_review_comment: {
      types: ["created"],
    },
    issues: {
      types: ["opened", "assigned"],
    },
  },
  jobs: {
    "claude-assistant": {
      if: dedent`
        (github.event_name == 'issue_comment' && contains(github.event.comment.body, '@claude')) ||
        (github.event_name == 'pull_request_review_comment' && contains(github.event.comment.body, '@claude')) ||
        (github.event_name == 'issues' && (contains(github.event.issue.body, '@claude') || contains(github.event.issue.title, '@claude')))
      `,
      ...utils.runsOn,
      permissions: {
        contents: "write",
        "pull-requests": "write",
        issues: "write",
        "id-token": "write",
        actions: "read",
      },
      steps: [
        {
          name: "Checkout repository",
          uses: "actions/checkout@v4",
          with: {
            "fetch-depth": 1,
          },
        },
        {
          name: "Setup Node.js",
          uses: "actions/setup-node@v4",
          with: {
            "node-version": "24",
          },
        },
        {
          name: "Setup pnpm via Corepack",
          run: dedent`
            corepack enable
            corepack prepare pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]") --activate
          `,
        },
        {
          name: "Install dependencies",
          run: "pnpm install",
        },
        {
          name: "Install Doppler CLI",
          uses: "dopplerhq/cli-action@v3",
        },
        {
          name: "Fetch secrets from Doppler",
          id: "doppler",
          run: dedent`
            echo "ANTHROPIC_API_KEY=$(doppler secrets get ANTHROPIC_API_KEY --plain)" >> $GITHUB_OUTPUT
          `,
          env: {
            DOPPLER_TOKEN: "${{ secrets.CLAUDE_DOPPLER_TOKEN }}",
          },
        },
        {
          name: "Run Claude Code",
          id: "claude",
          uses: "anthropics/claude-code-action@v1",
          with: {
            anthropic_api_key: "${{ steps.doppler.outputs.ANTHROPIC_API_KEY }}",
            assignee_trigger: "claude-bot",
            settings: dedent`
              {
                "env": {
                  "DOPPLER_TOKEN": "\${{ secrets.CLAUDE_DOPPLER_TOKEN }}"
                }
              }
            `,
            prompt: dedent`
              You are a helpful coding assistant. Follow the user's instructions and help them with their request.

              Environment setup:
              - Node.js v24 and pnpm v9 are available
              - DOPPLER_TOKEN is set in the environment for accessing secrets
              - You can run: pnpm dev, pnpm test, pnpm lint, pnpm typecheck, etc.
            `,
            claude_args: dedent`
              --model claude-sonnet-4-5-20250929
              --allowedTools "Edit,Write,Bash(pnpm i),Bash(pnpm test:*),Bash(pnpm eval:*),Bash(pnpm lint),Bash(pnpm typecheck),Bash(pnpm clean),Bash(pnpm dev)"
            `,
          },
        },
      ],
    },
  },
});
