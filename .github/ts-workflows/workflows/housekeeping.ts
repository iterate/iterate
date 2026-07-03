import { workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

// Cleanups that are too slow (or too bulk-churny) for every lint run live here instead: each
// entry applies its fixes to the working tree, then the combined result is formatted, proven to
// type-check, and pushed to a single self-updating PR. Add new cleanup steps to this list.
const cleanups = [
  {
    // verifies each cast removal by re-type-checking, which is why the
    // iterate/no-pointless-casts rule stays "off" in .oxlintrc.json
    name: "Remove pointless casts",
    run: "node scripts/remove-pointless-casts.ts",
  },
];

export default workflow({
  name: "Housekeeping",
  on: {
    schedule: [
      // weekly, monday morning UTC
      { cron: "0 5 * * 1" },
    ],
    workflow_dispatch: {},
    push: {
      branches: ["**/*housekeeping*"],
    },
  },
  jobs: {
    housekeeping: {
      ...utils.runsOnDepotUbuntu,
      steps: [
        ...utils.setupRepo,
        ...cleanups,
        {
          name: "Format",
          run: "pnpm format",
        },
        {
          // each cleanup is expected to verify its own changes; this proves the combination
          // holds before we open a PR
          name: "Typecheck",
          run: "pnpm typecheck",
        },
        {
          name: "Open pull request",
          env: {
            GH_TOKEN: "${{ secrets.ITERATE_BOT_GITHUB_TOKEN }}",
          },
          run: [
            "if git diff --quiet; then",
            '  echo "nothing to clean up"',
            "  exit 0",
            "fi",
            "git config user.name iterate-bot",
            "git config user.email bot@iterate.com",
            "branch=bot/housekeeping",
            'git checkout -b "$branch"',
            "git commit --all --message 'Weekly housekeeping'",
            'git push --force origin "$branch"',
            "if [ -z \"$(gh pr list --head $branch --state open --json number --jq '.[].number')\" ]; then",
            "  gh pr create \\",
            "    --title 'Weekly housekeeping' \\",
            "    --body 'Automated weekly cleanup — see the `Housekeeping` workflow for the steps that ran. Currently: removes `as` casts whose removal provably does not affect type-checking (each removal verified by the `iterate/no-pointless-casts` oxlint rule, and the combined result re-verified with a full `pnpm typecheck` before this PR was opened).'",
            "fi",
          ].join("\n"),
        },
      ],
    },
  },
});
