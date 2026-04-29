#!/usr/bin/env npx tsx
// Post channel test stimuli using credentials from channel-agent-poc/dev_jonas.
//
// This creates real platform messages/comments and prints the external links
// plus the expected agent stream links. Slack/Discord bot-authored messages are
// token smoke tests; browser/manual user messages remain the strongest proof.

const env = process.env;

function required(name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}. Run under channel-agent-poc/dev_jonas.`);
  return value;
}

async function jsonFetch(url: string, init: RequestInit): Promise<any> {
  const resp = await fetch(url, init);
  const text = await resp.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { text };
  }
  if (!resp.ok || json.ok === false || json.errors) {
    throw new Error(`${url} ${resp.status} ${text}`);
  }
  return json;
}

function slackThreadUrl(channel: string, ts: string) {
  return `https://iterate-com.slack.com/archives/${channel}/p${ts.replace(".", "")}`;
}

async function main() {
  const markerBase = `stimulus-${Math.floor(Date.now() / 1000)}`;
  const output: Record<string, unknown> = { markerBase };

  const slackToken =
    env.CHANNEL_TEST_SLACK_NITERATE_BOT_TOKEN ||
    env.CHANNEL_TEST_SLACK_CI_BOT_TOKEN ||
    env.CHANNEL_TEST_SLACK_OS_CI_BOT_TOKEN;
  if (slackToken) {
    const channel = required("CHANNEL_TEST_SLACK_CHANNEL_ID");
    const botUserId = required("CHANNEL_TEST_SLACK_BOT_USER_ID");
    const marker = `slack-${markerBase}`;
    const slack = await jsonFetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { authorization: `Bearer ${slackToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        channel,
        text: `<@${botUserId}> reply exactly marker ${marker}`,
      }),
    });
    const tsDashed = String(slack.ts).replace(".", "-");
    output.slack = {
      marker,
      externalUrl: slackThreadUrl(channel, String(slack.ts)),
      eventsUrl: `https://test.events.iterate.com/streams/agents/slack/ts-${tsDashed}/?renderer=raw-pretty&composer=json`,
      agentsUrl: `https://agents.test.iterate-dev-jonas.app/streams/%2Fagents%2Fslack%2Fts-${tsDashed}`,
      note: "Bot-authored Slack messages are a token smoke test; use a browser user message for final proof.",
    };
  }

  const githubToken = env.CHANNEL_TEST_GITHUB_USER_TOKEN || env.CHANNEL_TEST_GITHUB_TOKEN;
  if (githubToken) {
    const repoFullName = required("CHANNEL_TEST_GITHUB_REPO");
    const [owner, repo] = repoFullName.split("/");
    const pr = required("CHANNEL_TEST_GITHUB_PR_NUMBER");
    const appSlug = required("CHANNEL_TEST_GITHUB_APP_SLUG");
    const marker = `github-${markerBase}`;
    await jsonFetch(`https://api.github.com/repos/${owner}/${repo}/issues/${pr}/comments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${githubToken}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ body: `@${appSlug} reply exactly marker ${marker}` }),
    });
    output.github = {
      marker,
      externalUrl: `https://github.com/${repoFullName}/pull/${pr}`,
      eventsUrl: `https://test.events.iterate.com/streams/agents/github/pr-${owner}-${repo}-${pr}/?renderer=raw-pretty&composer=json`,
      agentsUrl: `https://agents.test.iterate-dev-jonas.app/streams/%2Fagents%2Fgithub%2Fpr-${owner}-${repo}-${pr}`,
    };
  }

  const linearToken = env.CHANNEL_TEST_LINEAR_USER_API_KEY || env.CHANNEL_TEST_LINEAR_API_KEY;
  if (linearToken) {
    const issueId = required("CHANNEL_TEST_LINEAR_ISSUE_ID");
    const issueIdentifier = required("CHANNEL_TEST_LINEAR_ISSUE_IDENTIFIER");
    const marker = `linear-${markerBase}`;
    await jsonFetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { authorization: linearToken, "content-type": "application/json" },
      body: JSON.stringify({
        query:
          "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }",
        variables: {
          input: { issueId, body: `@jonasland reply exactly marker ${marker}` },
        },
      }),
    });
    output.linear = {
      marker,
      externalIssue: issueIdentifier,
      eventsUrl: `https://test.events.iterate.com/streams/agents/linear/issue-${issueId}/?renderer=raw-pretty&composer=json`,
      agentsUrl: `https://agents.test.iterate-dev-jonas.app/streams/%2Fagents%2Flinear%2Fissue-${issueId}`,
    };
  }

  const discordToken = env.CHANNEL_TEST_DISCORD_APP_BOT_TOKEN || env.CHANNEL_TEST_DISCORD_BOT_TOKEN;
  if (discordToken) {
    const channelId = required("CHANNEL_TEST_DISCORD_CHANNEL_ID");
    const botUserId = required("CHANNEL_TEST_DISCORD_BOT_USER_ID");
    const marker = `discord-${markerBase}`;
    const discord = await jsonFetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: { authorization: `Bot ${discordToken}`, "content-type": "application/json" },
      body: JSON.stringify({ content: `<@${botUserId}> reply exactly marker ${marker}` }),
    });
    const streamPath = `/agents/discord/thread-${channelId}-${discord.id}`;
    output.discord = {
      marker,
      eventsUrl: `https://test.events.iterate.com/streams${streamPath}/?renderer=raw-pretty&composer=json`,
      agentsUrl: `https://agents.test.iterate-dev-jonas.app/streams/${encodeURIComponent(streamPath)}`,
      note: "Bot-authored Discord messages are a REST token smoke test; use a browser user message for final proof.",
    };
  }

  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
