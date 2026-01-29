import dedent from "dedent";
import type { Workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default {
  name: "CI",
  permissions: {
    contents: "read",
    deployments: "write",
  },
  on: {
    push: {
      branches: ["main"],
    },
    pull_request: {
      paths: ["apps/os/sandbox/daytona.test.ts", "apps/os/sandbox/daytona-bootstrap.test.ts"],
    },
    workflow_dispatch: {
      inputs: {
        stage: {
          description:
            "The stage to deploy to. Must correspond to a Doppler config in the os project (prd, stg, dev, dev_bob etc.).",
          required: false,
          type: "string",
        },
      },
    },
  },
  // todo: uncomment this once depot has unshat the bed
  //   concurrency: {
  //     group: "ci-${{ github.ref }}",
  //     "cancel-in-progress": false,
  //   },
  jobs: {
    /**
     * ${{ env.* }} limitations with reusable workflows:
     *     1. environment variables are not inherited by sub-workflows
     *     2. we can't reference ${{ env.* }} outside of a step
     *
     * This means we need a preliminary job that extracts whatever we need from env,
     * and then pass those values as inputs to the reusable workflow.
     */
    variables: {
      ...utils.runsOnUbuntuLatest,
      steps: [
        {
          id: "get_env",
          name: "Get environment variables",
          // todo: parse the PR number/body/whatever to get a stage like `pr_1234` and any other deployment flags

          run: dedent`
            echo stage=\${{ inputs.stage || 'prd' }} >> $GITHUB_OUTPUT
            echo release_name="v$(TZ=Europe/London date +%Y-%m-%d-%H-%M-%S)" >> $GITHUB_OUTPUT
          `,
        },
      ],
      outputs: {
        stage: "${{ steps.get_env.outputs.stage }}",
        release_name: "${{ steps.get_env.outputs.release_name }}",
      },
    },
    "build-snapshot": {
      needs: ["variables"],
      if: "needs.variables.outputs.stage == 'prd'",
      uses: "./.github/workflows/build-snapshot.yml",
      // @ts-expect-error - secrets inherit
      secrets: "inherit",
      with: {
        doppler_config: "prd",
      },
    },
    deploy: {
      uses: "./.github/workflows/deploy.yml",
      needs: ["variables", "build-snapshot"],
      // @ts-expect-error - is jlarky wrong here? https://github.com/JLarky/gha-ts/pull/46
      secrets: "inherit",
      with: {
        stage: "${{ needs.variables.outputs.stage }}",
        daytona_snapshot_name: "${{ needs.build-snapshot.outputs.snapshot_name }}",
      },
    },
    "daytona-test": {
      needs: ["variables"],
      if: "needs.variables.outputs.stage == 'prd' || github.event_name == 'pull_request'",
      ...utils.runsOn,
      steps: [
        ...utils.setupRepo,
        ...utils.setupDoppler({ config: "prd" }),
        {
          name: "Install cloudflared",
          run: dedent`
            # Detect architecture and download appropriate cloudflared binary
            ARCH=$(uname -m)
            if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
              CLOUDFLARED_ARCH="arm64"
            else
              CLOUDFLARED_ARCH="amd64"
            fi
            curl -L "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$CLOUDFLARED_ARCH" -o cloudflared
            chmod +x cloudflared
            sudo mv cloudflared /usr/local/bin/
            cloudflared --version
          `,
        },
        {
          name: "Run Daytona Tests",
          env: {
            RUN_DAYTONA_TESTS: "true",
            DAYTONA_API_KEY: "${{ secrets.DAYTONA_API_KEY }}",
            SANDBOX_ITERATE_REPO_REF: "${{ github.sha }}",
          },
          run: "pnpm os snapshot:daytona:test",
        },
      ],
    },
    release: {
      needs: ["variables", "deploy"],
      ...utils.runsOnUbuntuLatest,
      steps: [
        {
          name: "Checkout code",
          uses: "actions/checkout@v4",
          with: {
            "fetch-depth": 0,
          },
        },
        {
          name: "Write last release",
          run: `echo "LAST_RELEASE=$(git describe --tags --abbrev=0 || echo '')" >> $GITHUB_ENV`,
        },
        {
          name: "Write changelog",
          run: dedent`
            add_to_changelog() {
              echo "$1" >> changelog.md
              echo "" >> changelog.md
            }

            if [ "$LAST_RELEASE" = "" ]; then
              LAST_RELEASE=$(git rev-parse HEAD~1)
              add_to_changelog "No previous release found - using HEAD~1 ($LAST_RELEASE)"
            else
              add_to_changelog "Last tagged release: [$LAST_RELEASE](\${{ github.event.repository.html_url }}/releases/$LAST_RELEASE) ([compare link](\${{ github.event.repository.html_url }}/compare/$LAST_RELEASE...\${{ needs.variables.outputs.release_name }}))"
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

            add_to_changelog "Triggered by: @\${{ github.actor }}"

            add_to_changelog "[Comparison with current main](\${{ github.event.repository.html_url }}/compare/\${{ needs.variables.outputs.release_name }}...main)"

            echo "echoing changes for debugging (notes are not published unless deploying to production):"
            cat changelog.md
          `,
        },
        {
          if: "needs.variables.outputs.stage == 'prd'",
          ...utils.githubScript(
            import.meta,
            { "github-token": "${{ secrets.ITERATE_BOT_GITHUB_TOKEN }}" },
            async function prd_release({ github, context }) {
              const { promises: fs } = await import("fs");
              await github.rest.repos.createRelease({
                ...context.repo,
                tag_name: "${{ needs.variables.outputs.release_name }}",
                name: "${{ needs.variables.outputs.release_name }}",
                body: [
                  `stage: \${{ needs.variables.outputs.stage }}`,
                  "", //
                  await fs.readFile("changelog.md", "utf8"),
                ].join("\n"),
              });
            },
          ),
        },
      ],
    },
    slack_failure: {
      needs: ["variables", "build-snapshot", "deploy", "daytona-test", "release"],
      if: `always() && contains(needs.*.result, 'failure')`,
      "runs-on": "ubuntu-latest",
      env: { NEEDS: "${{ toJson(needs) }}" },
      steps: [
        ...utils.setupRepo,
        utils.githubScript(import.meta, async function notify_slack_on_failure() {
          const { getSlackClient, slackChannelIds } = await import("../utils/slack.ts");
          const slack = getSlackClient("${{ secrets.SLACK_CI_BOT_TOKEN }}");
          const needs = JSON.parse(process.env.NEEDS!);
          const failedJobs = Object.entries(needs)
            .filter(([_, { result }]: [string, any]) => result === "failure")
            .map(([name]) => name);
          const { release_name, ...outputs } = needs.variables?.outputs as Record<string, string>;
          const outputsString = new URLSearchParams(outputs).toString().replaceAll("&", ", ");
          let message = `🚨 ${failedJobs.join(", ")} failed on \${{ github.ref_name }}. ${outputsString}.`;
          message +=
            " <${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}|View Workflow Run>";
          await slack.chat.postMessage({
            channel: slackChannelIds["#error-pulse"],
            text: message,
          });
        }),
      ],
    },
  },
} satisfies Workflow;
