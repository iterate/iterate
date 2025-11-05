import type { Workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

export default {
  name: "Nag about PRs",
  on: {
    schedule: [
      // every fifteen minutes
      { cron: "*/15 * * * *" },
    ],
    push: {
      branches: ["**/*nag*"],
    },
  },
  jobs: {
    run: {
      ...utils.runsOnUbuntuLatest,
      steps: [
        ...utils.setupRepo,
        utils.githubScript(
          import.meta,
          { "github-token": "${{ secrets.ITERATE_BOT_GITHUB_TOKEN }}" },
          async function doit({ github, context }) {
            const { data: openPRs } = await github.rest.pulls.list({
              ...context.repo,
              state: "open",
            });

            console.log(`got ${openPRs.length} open PRs`);

            for (const pr of openPRs) {
              const { data: rawReviews } = await github.rest.pulls.listReviews({
                ...context.repo,
                pull_number: pr.number,
              });
              const { data: rawComments } = await github.rest.issues.listComments({
                ...context.repo,
                issue_number: pr.number,
              });
              const reviews = rawReviews
                .filter((r) => r.user?.type !== "Bot")
                .sort((a, b) => (a.submitted_at || "").localeCompare(b.submitted_at || ""));
              const comments = rawComments
                .filter((c) => c.user?.type !== "Bot")
                .sort((a, b) => a.created_at.localeCompare(b.created_at));

              console.log(pr.number, pr.title, reviews, comments);

              const approval = reviews.find((review) => review.state === "APPROVED");

              const lastNagTime = pr.body
                ?.split("\n")
                .flatMap((line) => {
                  const maybeParams = new URLSearchParams(
                    line.split(" ").find((p) => p.includes("=")),
                  );
                  const found = maybeParams.get("last_nag_time");
                  return found ? [new Date(found)] : [];
                })
                .findLast(Boolean); // find last time with nag info, since we append every couple of days

              const nodeIds = comments.map((c) => c.node_id).filter(Boolean);

              type Node = { id?: string; isMinimized?: boolean; minimizedReason?: string | null };
              const res = await github.graphql<{
                nodes: Array<Node | null>;
              }>(
                `
                  query($ids: [ID!]!) {
                    nodes(ids: $ids) {
                      ... on Node { id }
                      ... on Minimizable {
                        isMinimized
                        minimizedReason
                      }
                    }
                  }
                `,
                { ids: nodeIds },
              );
              const unresolvedComments = res.nodes?.filter((n) => !n?.isMinimized);

              const lastActive =
                [comments.at(-1)?.created_at, reviews.at(-1)?.submitted_at]
                  .filter(Boolean)
                  .map((d) => new Date(d!))
                  .sort((a, b) => a.getTime() - b.getTime())
                  .at(-1) || new Date(pr.created_at);

              const timeAgo = (d: Date | number | string) => {
                const ms = Date.now() - new Date(d).getTime();
                const props = {
                  ms: ms,
                  seconds: ms / 1000,
                  minutes: ms / (60 * 1000),
                  hours: ms / (60 * 60 * 1000),
                  days: ms / (24 * 60 * 60 * 1000),
                  weeks: ms / (7 * 24 * 60 * 60 * 1000),
                  years: ms / (365.25 * 24 * 60 * 60 * 1000),
                };
                const format = <Unit extends keyof typeof props>(unit: Unit) => {
                  return `${props[unit]} ${unit}${props[unit] === 1 ? "" : "s"} ago`;
                };
                const mostUseful = Object.entries(props).findLast(([_, value]) => value >= 1);
                return { ...props, format, pretty: format(mostUseful?.[0] as keyof typeof props) };
              };

              const when = (d: Date | null | undefined) => {
                if (!d) return "never";
                return timeAgo(d).pretty;
              };

              const reasonsToNag = {
                automerge: `${!!pr.auto_merge}: <-- automerge-status`,
                approval: approval ? `false: approved already` : `true: not approved yet`,
                unresolvedComments: `${unresolvedComments?.length === 0}: ${unresolvedComments?.length} unresolved comments`,
                noActivityForAWhile: `${timeAgo(lastActive).minutes > 60}: last active ${when(lastActive)}`,
              } as Record<string, `${boolean}: ${string}`>;

              const shouldNag = Object.values(reasonsToNag).every((v) => v.startsWith("true"));

              console.log(`PR #${pr.number}`, pr.title, pr.html_url, { reasonsToNag, shouldNag });

              if (shouldNag) {
                const { getSlackClient, slackChannelIds, slackUsers } = await import(
                  "../utils/slack.ts"
                );
                const slack = getSlackClient("${{ secrets.SLACK_CI_BOT_TOKEN }}");
                const slackUser = slackUsers.find(
                  (u) => u.github.toLowerCase() === pr.user?.login?.toLowerCase(),
                );
                const atMention = slackUser ? `<@${slackUser.id}>` : pr.user?.login;
                const message = await slack.chat.postMessage({
                  channel: slackChannelIds["#building"],
                  text: `PR ${pr.number} <${pr.html_url}|${pr.title}> by ${atMention} is set to auto-merge, but needs review.`,
                });

                const nagInfo = {
                  last_nag_time: new Date().toISOString(),
                  ...(message.ts && { nag_message_ts: message.ts }),
                };

                await github.rest.pulls.update({
                  ...context.repo,
                  pull_number: pr.number,
                  body: [
                    pr.body, //
                    "\n",
                    `${new URLSearchParams(nagInfo)}`,
                  ].join("\n"),
                });
              }

              // annoyingly "all comments must be resolved" in a ruleset doesn't let automerge happen for hidden comments, and cursor bugbot loves to hide comments
              const incorrectlyMinimizedComments = comments.filter((c) => {
                const node = res.nodes?.find(
                  (n) => n?.id === c.node_id && n?.minimizedReason?.toLowerCase() !== "resolved",
                );
                return node?.isMinimized;
              });
              console.info(`Incorrectly minimized comments`, incorrectlyMinimizedComments);

              for (const comment of incorrectlyMinimizedComments) {
                console.info(`comment ${comment.html_url} needs to be re-minimized as RESOLVED`);
                await github.graphql(
                  `
                        mutation($id: ID!) {
                        minimizeComment(input: { subjectId: $id, classifier: RESOLVED }) {
                            minimizedComment { id }
                        }
                        }
                    `,
                  { id: comment.node_id },
                );
                console.info(`Re-minimized as RESOLVED: ${comment.node_id} on PR #${pr.number}`);
              }
            }
          },
        ),
      ],
    },
  },
} satisfies Workflow;
