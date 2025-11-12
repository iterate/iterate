import dedent from "dedent";
import type { Workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default {
  name: "Push staging estate",
  on: {
    schedule: [
      // every day at 4am UTC
      { cron: "0 4 * * *" },
    ],
    push: {
      paths: [".github/workflows/push-staging-estate.yml"],
    },
  },
  jobs: {
    run: {
      ...utils.runsOnUbuntuLatest,
      steps: [
        {
          name: "Checkout code",
          uses: "actions/checkout@v4",
          with: {
            path: "main",
          },
        },
        {
          name: "Checkout staging-estate branch",
          uses: "actions/checkout@v4",
          with: {
            token: "${{ secrets.ITERATE_BOT_GITHUB_TOKEN }}",
            ref: "staging-estate",
            path: "staging-estate",
          },
        },
        {
          name: "Replace estate folder with contents from main",
          run: dedent`
            rm -rf staging-estate/estates/iterate
            mkdir -p staging-estate/estates
            cp -r main/estates/iterate staging-estate/estates/iterate
            rm -rf staging-estate/estates/iterate/apps
          `,
        },
        {
          name: "Commit and push",
          "working-directory": "staging-estate",
          run: dedent`
            git config user.name "\${{ github.actor }}"
            git config user.email "\${{ github.actor }}@users.noreply.github.com"

            git diff --exit-code || {
              git add .
              git commit -m "update staging estate"
              git push
            }

          `,
        },
      ],
    },
  },
} satisfies Workflow;
