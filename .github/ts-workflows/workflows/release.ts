import dedent from "dedent";
import type { Workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default {
  name: "Release",
  permissions: {
    contents: "write",
  },
  on: {
    schedule: [
      // 8pm UTC every day
      { cron: "0 20 * * *" },
    ],
    workflow_dispatch: {
      inputs: {
        release_title: {
          description: "Title for the release",
          required: true,
        },
        trigger_description: {
          description: "What triggered this release",
          required: true,
        },
      },
    },
    workflow_call: {
      inputs: {
        release_title: {
          description: "Title for the release",
          required: true,
          type: "string",
        },
        trigger_description: {
          description: "What triggered this release",
          required: true,
          type: "string",
        },
      },
    },
  },
  jobs: {
    release: {
      ...utils.runsOnGithubUbuntuStartsFastButNoContainers,
      steps: [
        {
          name: "Checkout code",
          uses: "actions/checkout@v4",
          with: {
            "fetch-depth": 0,
          },
        },
        {
          name: "Set trigger context",
          id: "context",
          run: dedent`
            echo "release_title=\${{ inputs.release_title || 'Daily scheduled release' }}" >> $GITHUB_OUTPUT
            echo "trigger_desc=\${{ format('{0}: {1}', github.event_name, inputs.trigger_description || github.event.schedule || 'unknown') }}" >> $GITHUB_OUTPUT
          `,
        },
        {
          name: "Get release info",
          id: "release_info",
          run: dedent`
            LAST_RELEASE=$(git describe --tags --abbrev=0 || echo '')
            echo "last_release=$LAST_RELEASE" >> $GITHUB_OUTPUT
            echo "release_name=v$(TZ=Europe/London date +%Y-%m-%d-%H-%M-%S)" >> $GITHUB_OUTPUT
          `,
        },
        {
          name: "Check for changes",
          id: "check_changes",
          run: dedent`
            LAST_RELEASE="\${{ steps.release_info.outputs.last_release }}"
            if [ "$LAST_RELEASE" = "" ]; then
              LAST_RELEASE=$(git rev-parse HEAD~1)
            fi

            COMMITS=$(git log $LAST_RELEASE..HEAD --oneline | wc -l)
            echo "commits=$COMMITS" >> $GITHUB_OUTPUT

            if [ "$COMMITS" -eq "0" ]; then
              echo "No new commits since last release"
            else
              echo "Found $COMMITS new commits since $LAST_RELEASE"
            fi
          `,
        },
        {
          name: "Write changelog",
          if: "steps.check_changes.outputs.commits != '0'",
          run: dedent`
            add_to_changelog() {
              echo "$1" >> changelog.md
              echo "" >> changelog.md
            }

            LAST_RELEASE="\${{ steps.release_info.outputs.last_release }}"
            RELEASE_NAME="\${{ steps.release_info.outputs.release_name }}"
            TRIGGER_DESC="\${{ steps.context.outputs.trigger_desc }}"

            if [ "$LAST_RELEASE" = "" ]; then
              LAST_RELEASE=$(git rev-parse HEAD~1)
              add_to_changelog "No previous release found - using HEAD~1 ($LAST_RELEASE)"
            else
              add_to_changelog "Last tagged release: [$LAST_RELEASE](\${{ github.event.repository.html_url }}/releases/$LAST_RELEASE) ([compare link](\${{ github.event.repository.html_url }}/compare/$LAST_RELEASE...$RELEASE_NAME))"
            fi

            write_git_changes() {
              glob=$1
              description=\${2:-$glob}

              changes=$(git log $LAST_RELEASE..HEAD --oneline -- $glob | sed 's/^/- /g')

              if [ "$changes" != "" ]; then
                add_to_changelog "## $description"
                add_to_changelog "$changes"
              fi
            }

            write_git_changes '.' 'changes'

            add_to_changelog "Triggered by: $TRIGGER_DESC"

            add_to_changelog "[Comparison with current main](\${{ github.event.repository.html_url }}/compare/$RELEASE_NAME...main)"

            echo "echoing changes for debugging:"
            cat changelog.md
          `,
        },
        {
          if: "steps.check_changes.outputs.commits != '0'",
          ...utils.githubScript(
            import.meta,
            { "github-token": "${{ secrets.ITERATE_BOT_GITHUB_TOKEN }}" },
            async function create_release({ github, context }) {
              const { promises: fs } = await import("fs");
              await github.rest.repos.createRelease({
                ...context.repo,
                tag_name: "${{ steps.release_info.outputs.release_name }}",
                name: "${{ steps.release_info.outputs.release_name }}",
                body: [
                  "${{ steps.context.outputs.release_title }}",
                  "", //
                  await fs.readFile("changelog.md", "utf8"),
                ].join("\n"),
              });
            },
          ),
        },
      ],
    },
  },
} satisfies Workflow;
