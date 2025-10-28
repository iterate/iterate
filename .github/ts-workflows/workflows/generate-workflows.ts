import dedent from "dedent";
import { workflow } from "@jlarky/gha-ts/workflow-types";

export default workflow({
  name: "Generate Workflows",
  on: {
    push: {},
  },
  jobs: {
    generate: {
      "runs-on": "ubuntu-latest",
      steps: [
        {
          name: "Checkout code",
          uses: "actions/checkout@v4",
          with: {
            "fetch-depth": 0,
            token: "${{ secrets.ITERATE_BOT_GITHUB_TOKEN }}",
            ref: "${{ github.head_ref }}",
          },
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
          name: "install",
          run: "pnpm install",
        },
        {
          name: "generate workflows",
          "working-directory": ".github/ts-workflows",
          run: "node cli.ts from-ts",
        },
        {
          name: "commit changes",
          run: dedent`
            status=$(git status --porcelain)
            if [ -z "$status" ]; then
              echo "No changes to commit"
              exit 0
            fi
            git config --global user.name "\${{ github.actor }}"
            git config --global user.email "\${{ github.actor }}@users.noreply.github.com"

            mkdir -p patches.ignoreme
            git diff > patches.ignoreme/autofix.patch
            echo "PATCH_FILE=patches.ignoreme/autofix.patch" >> $GITHUB_ENV
            git add .
            git commit -m 'chore: automated fixes' --no-verify

            git push || (echo 'Failed to push. Apply the patch file from workflow artifacts, then push the changes if they look correct.' && exit 1)
            echo "Changes committed and pushed"
          `,
        },
      ],
    },
  },
});
