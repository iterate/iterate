import type { Workflow } from "@jlarky/gha-ts/workflow-types";
import * as utils from "../utils/index.ts";

/**
 * Maintains a single "PR dashboard" Slack message per (UTC) day in #building, instead of
 * one message per merged PR. The first PR event of the day creates the message; subsequent
 * events update it in place. The Slack message ts is remembered in a repo Actions variable.
 */
export default {
  name: "Daily PR dashboard",
  on: {
    pull_request: {
      types: ["opened", "closed", "reopened", "ready_for_review"],
    },
    // for testing: pushing a branch with "pr-dashboard" in the name posts to #misha-test
    push: {
      branches: ["**/*pr-dashboard*", "*pr-dashboard*"],
    },
  },
  concurrency: {
    group: "pr-dashboard",
    "cancel-in-progress": false,
  },
  jobs: {
    update_dashboard: {
      ...utils.runsOnDepotUbuntu,
      steps: [
        ...utils.setupRepo,
        await utils.githubScript(
          import.meta,
          { "github-token": "${{ secrets.ITERATE_BOT_GITHUB_TOKEN }}" },
          async function update_pr_dashboard({ github, context }) {
            const { getSlackClient, slackChannelIds, slackUsers } =
              await import("../utils/slack.ts");

            const isTest = context.eventName !== "pull_request";
            const channel = isTest ? slackChannelIds["#misha-test"] : slackChannelIds["#building"];
            const stateVariableName = isTest
              ? "SLACK_PR_DASHBOARD_STATE_TEST"
              : "SLACK_PR_DASHBOARD_STATE";

            const slackToken = "${{ secrets.SLACK_CI_BOT_TOKEN }}";
            // when run locally via `node cli.ts github-script`, the secret above is an unexpanded
            // literal (careful not to write the expression-opener character sequence anywhere else
            // in this script - github rejects the whole workflow file as malformed if we do)
            const dryRun = slackToken.includes("secrets.SLACK_CI_BOT_TOKEN");

            const now = new Date();
            const today = now.toISOString().slice(0, 10);

            const search = async (queryParts: string) => {
              const repo = `${context.repo.owner}/${context.repo.repo}`;
              const { data } = await github.rest.search.issuesAndPullRequests({
                q: `repo:${repo} is:pr ${queryParts}`,
                per_page: 100,
                advanced_search: "true",
              });
              return data.items;
            };

            const [mergedTodayRaw, closedToday, openedToday, oldOpen] = await Promise.all([
              search(`merged:>=${today}`),
              search(`is:unmerged closed:>=${today}`),
              search(`is:open created:>=${today}`),
              search(`is:open created:<${today}`),
            ]);

            // search results don't include merge sha or base branch, so fetch each merged PR
            const mergedToday = await Promise.all(
              mergedTodayRaw.map(async (item) => {
                const { data: pr } = await github.rest.pulls.get({
                  ...context.repo,
                  pull_number: item.number,
                });
                return { item, pr };
              }),
            );
            mergedToday.sort((a, b) => (a.pr.merged_at || "").localeCompare(b.pr.merged_at || ""));

            const escape = (text: string) =>
              text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
            const link = (item: { number: number; title: string; html_url: string }) =>
              `<${item.html_url}|#${item.number} ${escape(item.title)}>`;
            const by = (login: string | undefined) => {
              const slackUser = slackUsers.find(
                (u) => u.github.toLowerCase() === (login || "").toLowerCase(),
              );
              return slackUser?.handle || login || "unknown";
            };

            const ordinal = (n: number) => {
              const suffixes = ["th", "st", "nd", "rd"];
              const mod100 = n % 100;
              return `${n}${suffixes[(mod100 - 20) % 10] || suffixes[mod100] || suffixes[0]}`;
            };
            const month = now.toLocaleString("en-GB", { month: "long", timeZone: "UTC" });
            const heading = `*PR dashboard ${ordinal(now.getUTCDate())} ${month}*`;

            const lines = [heading, ""];
            if (mergedToday.length) {
              lines.push("*Merged:*");
              for (const { item, pr } of mergedToday) {
                const sha = pr.merge_commit_sha?.slice(0, 7);
                const base = pr.base.ref === "main" ? "" : ` into \`${pr.base.ref}\``;
                lines.push(
                  `• ${link(item)} by ${by(item.user?.login)}${base}${sha ? ` (${sha})` : ""}`,
                );
              }
            }
            if (closedToday.length) {
              lines.push("*Closed without merging:*");
              for (const item of closedToday) {
                lines.push(`• ${link(item)} by ${by(item.user?.login)}`);
              }
            }
            if (openedToday.length) {
              lines.push("*Opened:*");
              const openedSorted = [...openedToday].sort((a, b) => a.number - b.number);
              for (const item of openedSorted) {
                const draft = item.draft ? " (draft)" : "";
                lines.push(`• ${link(item)} by ${by(item.user?.login)}${draft}`);
              }
            }
            if (oldOpen.length) {
              const oldLinks = [...oldOpen]
                .sort((a, b) => a.number - b.number)
                .map((item) => `<${item.html_url}|#${item.number}>`);
              lines.push(`Old: ${oldLinks.join(", ")}`);
            }
            const text = lines.join("\n");

            console.log(`Dashboard message for ${channel}:\n\n${text}`);
            if (dryRun) {
              console.log("Dry run (no Slack token available locally), not posting.");
              return;
            }

            const slack = getSlackClient(slackToken);

            type State = { date: string; channel: string; ts: string };
            const state: State | null = await github.rest.actions
              .getRepoVariable({ ...context.repo, name: stateVariableName })
              .then((res) => JSON.parse(res.data.value) as State)
              .catch((error: { status?: number }) => {
                if (error.status === 404) return null;
                throw error;
              });

            if (state && state.date === today && state.channel === channel) {
              const updated = await slack.chat
                .update({ channel, ts: state.ts, text })
                .catch((error) => {
                  // e.g. message_not_found if someone deleted today's message - post a fresh one
                  console.warn(`chat.update failed, posting a new message instead:`, error);
                  return null;
                });
              if (updated) {
                console.log(`Updated existing dashboard message ${state.ts}`);
                return;
              }
            }

            const message = await slack.chat.postMessage({ channel, text });
            if (!message.ts) throw new Error(`No ts in postMessage response`);
            const newState: State = { date: today, channel, ts: message.ts };
            await github.rest.actions
              .updateRepoVariable({
                ...context.repo,
                name: stateVariableName,
                value: JSON.stringify(newState),
              })
              .catch(async (error: { status?: number }) => {
                if (error.status !== 404) throw error;
                await github.rest.actions.createRepoVariable({
                  ...context.repo,
                  name: stateVariableName,
                  value: JSON.stringify(newState),
                });
              });
            console.log(`Posted new dashboard message ${message.ts}`);
          },
        ),
      ],
    },
  },
} satisfies Workflow;
