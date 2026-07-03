import type { RestEndpointMethodTypes } from "@octokit/rest";

import { isMainModule } from "../../packages/shared/src/dev/is-main-module.ts";
import { getEventName, getOctokit, getRepo } from "./github.ts";
import { getSlackClient, slackChannelIds, slackUsers } from "./slack.ts";

export async function updatePrDashboard() {
  const github = getOctokit();
  const repo = getRepo();
  const isTest = getEventName() !== "pull_request";
  const channel = isTest ? slackChannelIds["#misha-test"] : slackChannelIds["#ci"];
  const stateVariableName = isTest ? "SLACK_PR_DASHBOARD_STATE_TEST" : "SLACK_PR_DASHBOARD_STATE";
  const dryRun = !process.env.CI;

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const search = async (queryParts: string) => {
    const { data } = await github.rest.search.issuesAndPullRequests({
      q: `repo:${repo.owner}/${repo.repo} is:pr ${queryParts}`,
      per_page: 100,
    });
    return data.items;
  };

  const [mergedTodayRaw, closedToday, openedToday, oldOpen] = await Promise.all([
    search(`merged:>=${today}`),
    search(`is:unmerged closed:>=${today}`),
    search(`is:open created:>=${today}`),
    search(`is:open created:<${today}`),
  ]);

  const mergedToday = await Promise.all(
    mergedTodayRaw.map(async (item) => {
      const { data: pr } = await github.rest.pulls.get({
        ...repo,
        pull_number: item.number,
      });
      return { item, pr };
    }),
  );
  mergedToday.sort((a, b) => (a.pr.merged_at || "").localeCompare(b.pr.merged_at || ""));

  /** A PR as returned by Octokit's search.issuesAndPullRequests. */
  type PrSearchItem =
    RestEndpointMethodTypes["search"]["issuesAndPullRequests"]["response"]["data"]["items"][number];
  const link = (item: PrSearchItem) =>
    `<${item.html_url}|#${item.number} ${item.title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}>`;
  const by = (login: string | undefined) => {
    const slackUser = slackUsers.find(
      (user) => user.github.toLowerCase() === (login || "").toLowerCase(),
    );
    return slackUser?.handle || login || "unknown";
  };

  const heading = `*PR dashboard ${ordinal(now.getUTCDate())} ${now.toLocaleString("en-GB", {
    month: "long",
    timeZone: "UTC",
  })}*`;
  const counts = [
    `${mergedToday.length} merged`,
    closedToday.length ? `${closedToday.length} closed without merging` : "",
    `${openedToday.length} opened`,
    oldOpen.length ? `${oldOpen.length} older still open` : "",
  ].filter(Boolean);
  const summaryText = `${heading} — ${counts.join(" · ")} (details in thread)`;

  const lines: string[] = [];
  if (mergedToday.length) {
    lines.push("*Merged:*");
    for (const { item, pr } of mergedToday) {
      const sha = pr.merge_commit_sha?.slice(0, 7);
      const base = pr.base.ref === "main" ? "" : ` into \`${pr.base.ref}\``;
      lines.push(`• ${link(item)} by ${by(item.user?.login)}${base}${sha ? ` (${sha})` : ""}`);
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
    for (const item of [...openedToday].sort((a, b) => a.number - b.number)) {
      lines.push(`• ${link(item)} by ${by(item.user?.login)}${item.draft ? " (draft)" : ""}`);
    }
  }
  if (oldOpen.length) {
    const oldLinks = [...oldOpen]
      .sort((a, b) => a.number - b.number)
      .map((item) => `<${item.html_url}|#${item.number}>`);
    lines.push(`Old: ${oldLinks.join(", ")}`);
  }

  console.log(
    `Dashboard for ${channel}:\n\n${summaryText}\n\n--- thread ---\n\n${lines.join("\n")}`,
  );
  if (dryRun) {
    console.log("Dry run (no CI env), not posting.");
    return;
  }

  const detailsPayload = {
    channel,
    text: heading.replaceAll("*", ""),
    blocks: chunkSlackBlocks(lines),
  };
  const slack = getSlackClient();
  type State = { date: string; channel: string; ts: string; details_ts?: string };
  const state: State | null = await github.rest.actions
    .getRepoVariable({ ...repo, name: stateVariableName })
    .then((res) => JSON.parse(res.data.value) as State)
    .catch((error: { status?: number }) => {
      if (error.status === 404) return null;
      throw error;
    });

  const writeState = async (newState: State) => {
    const value = JSON.stringify(newState);
    await github.rest.actions
      .updateRepoVariable({ ...repo, name: stateVariableName, value })
      .catch(async (error: { status?: number }) => {
        if (error.status !== 404) throw error;
        await github.rest.actions.createRepoVariable({ ...repo, name: stateVariableName, value });
      });
  };
  const postDetailsInThread = async (parentTs: string) => {
    const details = await slack.chat.postMessage({
      ...detailsPayload,
      thread_ts: parentTs,
    });
    if (!details.ts) throw new Error("No ts in details postMessage response");
    return details.ts;
  };

  if (state && state.date === today && state.channel === channel) {
    const updated = await slack.chat
      .update({ channel, ts: state.ts, text: summaryText, blocks: [] })
      .catch((error) => {
        console.warn("chat.update failed, posting a new message instead:", error);
        return null;
      });
    if (updated) {
      const detailsUpdated =
        state.details_ts &&
        (await slack.chat.update({ ...detailsPayload, ts: state.details_ts }).catch((error) => {
          console.warn("details chat.update failed, re-posting in thread:", error);
          return null;
        }));
      if (!detailsUpdated) {
        await writeState({ ...state, details_ts: await postDetailsInThread(state.ts) });
      }
      console.log(`Updated existing dashboard message ${state.ts}`);
      return;
    }
  }

  const message = await slack.chat.postMessage({ channel, text: summaryText });
  if (!message.ts) throw new Error("No ts in postMessage response");
  const detailsTs = await postDetailsInThread(message.ts);
  await writeState({ date: today, channel, ts: message.ts, details_ts: detailsTs });
  console.log(`Posted new dashboard message ${message.ts} (details ${detailsTs})`);
}

function chunkSlackBlocks(lines: string[]) {
  const blockChars = 2900;
  const chunks: string[] = [];
  for (const line of lines.flatMap((line) => splitLongLine(line, blockChars))) {
    const last = chunks.at(-1);
    if (last !== undefined && last.length + 1 + line.length <= blockChars) {
      chunks[chunks.length - 1] = `${last}\n${line}`;
    } else {
      chunks.push(line);
    }
  }
  if (chunks.length > 49) {
    const dropped = chunks.splice(49).join("\n").split("\n").length;
    chunks.push(`_...${dropped} more lines truncated_`);
  }
  return chunks.map((chunk) => ({
    type: "section" as const,
    text: { type: "mrkdwn" as const, text: chunk },
  }));
}

function splitLongLine(line: string, maxLength: number) {
  if (line.length <= maxLength) return [line];
  const parts: string[] = [];
  let current = "";
  for (const piece of line.split(", ")) {
    const candidate = current ? `${current}, ${piece}` : piece;
    if (candidate.length > maxLength && current) {
      parts.push(current);
      current = piece;
    } else {
      current = candidate;
    }
  }
  return [...parts, current];
}

function ordinal(n: number) {
  const suffixes = ["th", "st", "nd", "rd"];
  const mod100 = n % 100;
  return `${n}${suffixes[(mod100 - 20) % 10] || suffixes[mod100] || suffixes[0]}`;
}

if (isMainModule(import.meta.url)) {
  await updatePrDashboard();
}
