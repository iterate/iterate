import { getEventName, getOctokit, getRepo, prState, readEventPayload } from "./github.ts";
import { isMainModule } from "./main-module.ts";
import { getSlackClient, slackChannelIds, slackUsers } from "./slack.ts";

type NagInfo = {
  time: string;
  channel: string;
  message_ts?: string;
  followup_message_ts?: string;
};

export async function nagPrs() {
  const github = getOctokit();
  const repo = getRepo();
  const eventName = getEventName();
  const payload = readEventPayload();
  const isTest = eventName === "push" && process.env.GITHUB_ACTOR === "mmkal";

  console.log("event", JSON.stringify({ eventName, action: payload.action }, null, 2));

  if (eventName === "pull_request" && payload.action === "closed") {
    const state = prState<{ nags: Array<NagInfo> }>(payload.pull_request?.body || "", "nag_info");
    const nags = state.read().nags?.filter((nag) => nag.message_ts) || [];
    for (const nag of nags) {
      await getSlackClient().reactions.add({
        channel: nag.channel || slackChannelIds["#building"],
        timestamp: nag.message_ts!,
        name: payload.pull_request?.merged ? "merged" : "x",
      });
    }
    return;
  }

  const { data: openPRs } = await github.rest.pulls.list({
    ...repo,
    state: "open",
  });
  console.log(`got ${openPRs.length} open PRs`);

  for (const pr of openPRs) {
    const [{ data: rawReviews }, { data: rawComments }] = await Promise.all([
      github.rest.pulls.listReviews({ ...repo, pull_number: pr.number }),
      github.rest.issues.listComments({ ...repo, issue_number: pr.number }),
    ]);

    const reviews = rawReviews
      .filter((review) => review.user?.type !== "Bot")
      .sort((a, b) => (a.submitted_at || "").localeCompare(b.submitted_at || ""));
    const comments = rawComments
      .filter((comment) => comment.user?.type !== "Bot")
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const approval = reviews.find((review) => review.state === "APPROVED");
    const state = prState<{ nags: Array<NagInfo> }>(pr.body || "", "nag_info");
    const nodeIds = comments.map((comment) => comment.node_id).filter(Boolean);
    const graphqlResult = await github.graphql<{
      nodes: Array<{ id?: string; isMinimized?: boolean; minimizedReason?: string | null } | null>;
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
    const unresolvedComments = graphqlResult.nodes?.filter((node) => !node?.isMinimized);
    const lastActive =
      [comments.at(-1)?.created_at, reviews.at(-1)?.submitted_at]
        .filter(Boolean)
        .map((value) => new Date(value!))
        .sort((a, b) => a.getTime() - b.getTime())
        .at(-1) || new Date(pr.created_at);
    const workingHours = isTest ? () => true : realWorkingHours;
    const lastNagTime = state.read().nags?.at(-1)?.time;
    const reasonsToNag = {
      automerge: `${!!pr.auto_merge}: <-- automerge-status`,
      approval: approval ? "false: approved already" : "true: not approved yet",
      unresolvedComments: `${unresolvedComments?.length === 0}: ${unresolvedComments?.length} unresolved comments`,
      noActivityForAWhile: `${timeAgo(lastActive).minutes > 60}: last active ${when(lastActive)}`,
      noNagForAWhile: `${timeAgo(lastNagTime || 0).hours > 2}: last nag ${when(lastNagTime)}`,
      workingHours: `${workingHours(new Date())}: is working hours`,
    } as Record<string, `${boolean}: ${string}`>;

    if (
      eventName === "pull_request" &&
      payload.action === "auto_merge_enabled" &&
      pr.number === payload.pull_request?.number
    ) {
      delete reasonsToNag.noActivityForAWhile;
    }

    const shouldNag = Object.values(reasonsToNag).every((value) => value.startsWith("true"));
    console.log(`PR #${pr.number}`, pr.title, pr.html_url, { reasonsToNag, shouldNag });

    if (shouldNag) {
      await nagOrGiveUp({ github, repo, pr, state, isTest });
    }

    const incorrectlyMinimizedComments = comments.filter((comment) => {
      const node = graphqlResult.nodes?.find(
        (node) =>
          node?.id === comment.node_id && node?.minimizedReason?.toLowerCase() !== "resolved",
      );
      return node?.isMinimized;
    });
    console.info("Incorrectly minimized comments", incorrectlyMinimizedComments);

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
}

type PullRequest = {
  number: number;
  title: string;
  html_url: string;
  body?: string | null;
  user?: { login?: string } | null;
};

async function nagOrGiveUp({
  github,
  repo,
  pr,
  state,
  isTest,
}: {
  github: ReturnType<typeof getOctokit>;
  repo: ReturnType<typeof getRepo>;
  pr: PullRequest;
  state: ReturnType<typeof prState<{ nags: Array<NagInfo> }>>;
  isTest: boolean;
}) {
  const slack = getSlackClient();
  const slackUser = slackUsers.find(
    (user) => user.github.toLowerCase() === pr.user?.login?.toLowerCase(),
  );
  const authorMention = slackUser ? `<@${slackUser.id}>` : pr.user?.login;
  const newNag: NagInfo = {
    time: new Date().toISOString(),
    channel: isTest ? slackChannelIds["#misha-test"] : slackChannelIds["#building"],
  };
  const lastNag = state.read().nags?.at(-1);

  if (lastNag?.followup_message_ts) {
    console.log("Followup message already exists, giving up.");
    return;
  }

  const postMessage = (params: { text: string; thread_ts?: string }) =>
    slack.chat.postMessage({
      channel: newNag.channel,
      ...params,
      ...(isTest && { text: params.text.replaceAll("<@U", "<...U") }),
    });

  if (lastNag?.message_ts) {
    const othersMentions = slackUsers
      .filter((user) => user.github.toLowerCase() !== pr.user?.login?.toLowerCase())
      .filter((user) => new Date(user.oooUntil || 0).getTime() < Date.now())
      .map((user) => `<@${user.id}>`)
      .join(" ");
    const followup = await postMessage({
      thread_ts: lastNag.message_ts,
      text: `C'mon ${othersMentions}, poor ${authorMention} is waiting for your review on <${pr.html_url}|#${pr.number} ${pr.title}>`,
    });
    if (followup.ts) {
      newNag.followup_message_ts = followup.ts;
    }
  } else {
    const message = await postMessage({
      text: `<${pr.html_url}|#${pr.number} ${pr.title}> by ${authorMention} is set to auto-merge, but needs review.`,
    });
    if (message.ts) {
      newNag.message_ts = message.ts;
    }
  }

  await github.rest.pulls.update({
    ...repo,
    pull_number: pr.number,
    body: state.write({
      nags: [...(state.read().nags || []), newNag],
    }),
  });
}

function realWorkingHours(now: Date) {
  const [hour, day] = [now.getHours(), now.getDay()];
  return hour >= 9 && hour < 18 && day !== 0 && day !== 6;
}

function when(date: Date | null | undefined | string) {
  if (!date) return "never";
  return timeAgo(date).pretty;
}

function timeAgo(date: Date | number | string) {
  const ms = Date.now() - new Date(date).getTime();
  const values = {
    ms,
    seconds: ms / 1000,
    minutes: ms / (60 * 1000),
    hours: ms / (60 * 60 * 1000),
    days: ms / (24 * 60 * 60 * 1000),
    weeks: ms / (7 * 24 * 60 * 60 * 1000),
    years: ms / (365.25 * 24 * 60 * 60 * 1000),
  };
  const format = (unit: keyof typeof values) => {
    const int = Math.floor(values[unit]);
    return `${int} ${unit}${int === 1 ? "" : "s"} ago`;
  };
  const mostUseful = Object.entries(values).findLast(([, value]) => value >= 1);
  const unit = (mostUseful?.[0] as keyof typeof values) || "ms";
  return { ...values, format, pretty: format(unit) };
}

if (isMainModule(import.meta.url)) {
  await nagPrs();
}
