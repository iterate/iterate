import dedent from "dedent";
import { workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default workflow({
  name: "Generate Workflows",
  on: {
    push: {},
  },
  jobs: {
    generate: {
      ...utils.runsOn,
      steps: [
        ...utils.setupRepo.map((step) => {
          if (step.name === "Checkout code") {
            return {
              ...step,
              with: {
                "fetch-depth": 0,
                token: "${{ secrets.ITERATE_BOT_GITHUB_TOKEN }}",
              },
            };
          }
          return step;
        }),
        {
          name: "generate workflows",
          "working-directory": ".github/ts-workflows",
          run: "node cli.ts from-ts",
        },
        {
          name: "commit changes",
          if: "always()",
          run: dedent`
            status="$(git status --porcelain)"
            if [ -z "$status" ]; then
              echo "No changes to commit."
              exit 0
            fi
            # if latest commit message contains "chore: automated fixes", skip commit
            if git log -1 --pretty=%B | grep -q "chore: automated fixes"; then
              echo "Latest commit message contains 'chore: automated fixes'. Failing to prevent infinite loop."
              exit 1
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
