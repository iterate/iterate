import type { Workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default {
  name: "Notify Slack on merge to main",
  on: {
    pull_request: {
      types: ["closed"],
      branches: ["main"],
    },
  },
  jobs: {
    notify: {
      if: "github.event.pull_request.merged == true",
      ...utils.runsOnUbuntuLatest,
      steps: [
        ...utils.setupRepo,
        utils.githubScript(import.meta, async function notify_slack_on_merge({ context }) {
          const { getSlackClient, slackChannelIds } = await import("../utils/slack.ts");
          const slack = getSlackClient("${{ secrets.SLACK_CI_BOT_TOKEN }}");
          const pr = context.payload.pull_request;
          if (!pr) return;

          const number = pr.number;
          const title = pr.title;
          const url = pr.html_url;
          const author = pr.user?.login;
          const merger = pr.merged_by?.login;
          const sha = pr.merge_commit_sha?.slice(0, 7);

          const pieces = [
            `✅ Merged to main: <${url}|#${number} ${title}>`,
            author ? `by ${author}` : null,
            merger ? `merged by ${merger}` : null,
            sha ? `(${sha})` : null,
          ].filter(Boolean);

          await slack.chat.postMessage({
            channel: slackChannelIds["#building"],
            text: pieces.join(" "),
          });
        }),
      ],
    },
  },
} satisfies Workflow;
