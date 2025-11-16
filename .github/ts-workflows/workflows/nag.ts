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
      branches: ["**/*nag*", "*nag*"],
      // paths: [".github/workflows/nag.yml"],
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

              type NagInfo = { time: string; message_ts?: string; followup_message_ts?: string };

              const { prState } = await import("../utils/github-script.ts");

              const state = prState<{ nags: Array<NagInfo> }>(pr.body || "", "nag_info");

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
                  const int = Math.floor(props[unit]);
                  return `${int} ${unit}${int === 1 ? "" : "s"} ago`;
                };
                const mostUseful = Object.entries(props).findLast(([_, value]) => value >= 1);
                return { ...props, format, pretty: format(mostUseful?.[0] as keyof typeof props) };
              };

              const when = (d: Date | null | undefined | string) => {
                if (!d) return "never";
                return timeAgo(d).pretty;
              };

              const isTest = context.eventName === "push" && context.actor === "mmkal";

              const realWorkingHours = (now: Date) => {
                const [hour, day] = [now.getHours(), now.getDay()];
                return hour >= 9 && hour < 18 && day !== 0 && day !== 6;
              };
              const testWorkingHours: typeof realWorkingHours = () => {
                return true;
              };
              const workingHours = isTest ? testWorkingHours : realWorkingHours;

              const lastNagTime = state.read().nags?.at(-1)?.time;

              const reasonsToNag = {
                automerge: `${!!pr.auto_merge}: <-- automerge-status`,
                approval: approval ? `false: approved already` : `true: not approved yet`,
                unresolvedComments: `${unresolvedComments?.length === 0}: ${unresolvedComments?.length} unresolved comments`,
                noActivityForAWhile: `${timeAgo(lastActive).minutes > 60}: last active ${when(lastActive)}`,
                noNagForAWhile: `${timeAgo(lastNagTime || 0).hours > 2}: last nag ${when(lastNagTime)}`,
                workingHours: `${workingHours(new Date())}: is working hours: ${workingHours.toString().match(/return (.*?);/)?.[1]}`,
              } as Record<string, `${boolean}: ${string}`>;

              const shouldNag = Object.values(reasonsToNag).every((v) => v.startsWith("true"));

              console.log(`PR #${pr.number}`, pr.title, pr.html_url, { reasonsToNag, shouldNag });

              const { getSlackClient, slackChannelIds, slackUsers } = await import(
                "../utils/slack.ts"
              );
              const slack = getSlackClient("${{ secrets.SLACK_CI_BOT_TOKEN }}");
              const slackUser = slackUsers.find(
                (u) => u.github.toLowerCase() === pr.user?.login?.toLowerCase(),
              );
              const authorMention = slackUser ? `<@${slackUser.id}>` : pr.user?.login;

              const nagOrGiveUp = async () => {
                const newNag: NagInfo = {
                  time: new Date().toISOString(),
                };

                const lastNag = state.read().nags?.at(-1);

                if (lastNag?.followup_message_ts) {
                  console.log(`Followup message already exists, giving up.`);
                  return;
                }

                if (lastNag?.message_ts) {
                  const othersMentions = slackUsers
                    .filter((u) => u.github.toLowerCase() !== pr.user?.login?.toLowerCase())
                    .filter((u) => new Date(u.oooUntil || 0).getTime() < Date.now())
                    .map((u) => `<@${u.id}>`)
                    .join(" ")
                    .replaceAll("@", isTest ? "..." : "@");

                  const followup = await slack.chat.postMessage({
                    channel: slackChannelIds[isTest ? "#misha-test" : "#building"],
                    thread_ts: lastNag.message_ts,
                    text: `C'mon ${othersMentions}, poor ${authorMention} is waiting for your review on <${pr.html_url}|#${pr.number} ${pr.title}>`,
                  });
                  if (followup.ts) {
                    newNag.followup_message_ts = followup.ts;
                  }
                } else {
                  const message = await slack.chat.postMessage({
                    channel: slackChannelIds["#misha-test"],
                    text: `<${pr.html_url}|#${pr.number} ${pr.title}> by ${authorMention} is set to auto-merge, but needs review.`,
                  });
                  if (message.ts) {
                    newNag.message_ts = message.ts;
                  }
                }

                await github.rest.pulls.update({
                  ...context.repo,
                  pull_number: pr.number,
                  body: state.write({
                    nags: [
                      ...(state.read().nags || []), // break
                      newNag,
                    ],
                  }),
                });
              };

              if (shouldNag) {
                await nagOrGiveUp();
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
                const dedent = String;
                await github.graphql(
                  dedent`
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
