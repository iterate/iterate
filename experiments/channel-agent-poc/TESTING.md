# Channel Agent POC Testing

Always run tests under the POC Doppler project:

```bash
cd experiments/channel-agent-poc/nested-facets
doppler setup --project channel-agent-poc --config dev_jonas
```

## Smoke Test Deployment

```bash
doppler run -- ./scripts/deploy.sh
```

This verifies:

- Cloudflare Artifacts token works,
- `base-template` sync works,
- live project rebase works,
- all dynamic channel apps build.

## Fresh Project Webchat Codemode Proof

Create a brand-new project from the browser or admin API, build `agents`, then
open the agents app in the browser:

```bash
SLUG="webchat-proof-$(date +%s)"
curl -fsS -X POST "https://iterate-dev-jonas.app/admin/api/projects" \
  -H "content-type: application/json" \
  -d "{\"slug\":\"${SLUG}\",\"apps\":[\"agents\"]}" | jq .
curl -fsS -X POST "https://${SLUG}.iterate-dev-jonas.app/api/build/agents" | jq .
agent-browser connect 9222
agent-browser open "https://agents.${SLUG}.iterate-dev-jonas.app/"
```

If nested app-subdomain TLS is still provisioning, use the project-host fallback:

```bash
agent-browser open "https://${SLUG}.iterate-dev-jonas.app/apps/agents/"
```

Send this through the visible webchat composer:

```text
Please use codemode only. Call webchat.sendMessage with exactly this message: webchat-codemode-proof-<timestamp>. Return the result.
```

Proof requires the stream to contain `events.iterate.com/agent-webchat/message-received`,
`events.iterate.com/agent/request-started`,
`events.iterate.com/codemode/block-added`,
`events.iterate.com/agent-webchat/response-added`, and
`events.iterate.com/codemode/result-added`.

The events stream is:

```text
https://<slug>.events.iterate.com/streams/agents/webchat/?renderer=raw-pretty&composer=json
```

## Post Test Stimuli

The one-command stimulus helper posts to every channel it can using tokens from
`channel-agent-poc/dev_jonas` and prints the external links plus agent stream
links:

```bash
doppler run -- npx tsx scripts/post-channel-test-stimuli.ts
```

This helper uses:

- `CHANNEL_TEST_SLACK_NITERATE_BOT_TOKEN`, falling back to the CI Slack bot
  tokens, to post a Slack mention.
- `CHANNEL_TEST_GITHUB_USER_TOKEN` to post a GitHub PR comment.
- `CHANNEL_TEST_LINEAR_USER_API_KEY` to post a Linear issue comment.
- `CHANNEL_TEST_DISCORD_APP_BOT_TOKEN` to post a Discord REST smoke message.

Slack and Discord bot-authored messages are smoke tests for token/API access.
Use browser/manual user messages for final end-to-end proof on those platforms.

## Check App Health

```bash
doppler run -- bash -lc '
set -euo pipefail
for host in "$CHANNEL_TEST_AGENTS_HOST" "$CHANNEL_TEST_SLACK_HOST" "$CHANNEL_TEST_GITHUB_HOST" "$CHANNEL_TEST_LINEAR_HOST" "$CHANNEL_TEST_DISCORD_HOST"; do
  printf "%s " "$host"
  curl -fsS "https://${host}/" | head -c 80
  printf "\n"
done
curl -fsS "https://${CHANNEL_TEST_DISCORD_HOST}/api/gateway-status" | jq .
'
```

## What Counts As Working

A channel is working only when all of these are true:

1. the raw platform event appears in the global raw stream,
2. the same raw event appears in the agent thread stream,
3. a channel processor appends `agent-input-added`,
4. an LLM request starts and completes,
5. a codemode block is appended,
6. a codemode result is appended,
7. the external channel shows the bot response,
8. a follow-up message lands in the same agent thread stream.

Do not count webhook arrival alone as success.

## Event Stream Links

Replace the path after `/streams/` as needed:

```text
https://test.events.iterate.com/streams/agents/slack/ts-<thread-ts-dashed>/?renderer=raw-pretty&composer=json
https://test.events.iterate.com/streams/agents/github/pr-<owner>-<repo>-<number>/?renderer=raw-pretty&composer=json
https://test.events.iterate.com/streams/agents/linear/issue-<issue-id>/?renderer=raw-pretty&composer=json
https://test.events.iterate.com/streams/agents/discord/thread-<channel-id>-<root-message-id>/?renderer=raw-pretty&composer=json
```

Agents mini app deep link:

```text
https://agents.test.iterate-dev-jonas.app/streams/<url-encoded-stream-path>
```

Example encoded path:

```text
https://agents.test.iterate-dev-jonas.app/streams/%2Fagents%2Fslack%2Fts-1777472629-715939
```

## Slack Test

Canonical proof: post from a real Slack user in the configured channel:

```text
<@U08T48230AD> reply exactly marker slack-proof-<timestamp>
```

Then open the Slack thread and the matching agent stream.

With the user's logged-in Chrome session:

```bash
agent-browser connect 9222
agent-browser tab list
agent-browser tab <slack-tab-id>
agent-browser snapshot -i
MARKER="slack-browser-$(date +%s)"
agent-browser fill <message-textbox-ref> "<@U08T48230AD> reply exactly marker ${MARKER}"
agent-browser click <send-button-ref>
```

The channel is `#test-blank` in workspace `iterate`. If the composer already
contains draft text, clear it before sending; Slack will preserve the draft
prefix otherwise.

The niterate/CI bot tokens can post stimulus messages, but Slack may not deliver
bot messages to the Jonasland app as `app_mention`/`message.channels` events in
the same way as real user messages. If the stream only contains
`stream/initialized` after this command, use the manual user-message proof
above.

```bash
doppler run -- bash -lc '
set -euo pipefail
MARKER="slack-proof-$(date +%s)"
RESP=$(curl -fsS -X POST "https://slack.com/api/chat.postMessage" \
  -H "authorization: Bearer ${CHANNEL_TEST_SLACK_NITERATE_BOT_TOKEN:-${CHANNEL_TEST_SLACK_CI_BOT_TOKEN}}" \
  -H "content-type: application/json" \
  -d "{\"channel\":\"${CHANNEL_TEST_SLACK_CHANNEL_ID}\",\"text\":\"<@${CHANNEL_TEST_SLACK_BOT_USER_ID}> reply exactly marker ${MARKER}\"}")
echo "$RESP" | jq .
TS=$(echo "$RESP" | jq -r .ts)
PATH_TS=${TS/./-}
echo "marker=${MARKER}"
echo "slack=https://iterate-com.slack.com/archives/${CHANNEL_TEST_SLACK_CHANNEL_ID}/p${TS/./}"
echo "events=https://test.events.iterate.com/streams/agents/slack/ts-${PATH_TS}/?renderer=raw-pretty&composer=json"
echo "agents=https://agents.test.iterate-dev-jonas.app/streams/%2Fagents%2Fslack%2Fts-${PATH_TS}"
'
```

Expected external behavior: the Jonasland Slack app replies in the thread and
reacts to the triggering message. Expected stream behavior: raw
`events.iterate.com/slack/webhook-received`, `agent-input-added`,
`events.iterate.com/agent/request-started`, `events.iterate.com/codemode/block-added`, and `events.iterate.com/codemode/result-added`.

To resolve the exact Slack stream for a browser-authored message:

```bash
doppler run -- bash -lc '
set -euo pipefail
MARKER="slack-browser-<timestamp>"
node <<'"'"'NODE'"'"'
const marker = process.env.MARKER;
const env = process.env;
const resp = await fetch("https://slack.com/api/conversations.history", {
  method: "POST",
  headers: {
    authorization: `Bearer ${env.CHANNEL_TEST_SLACK_BOT_TOKEN}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ channel: env.CHANNEL_TEST_SLACK_CHANNEL_ID, limit: 50 }),
});
const hist = await resp.json();
const msg = hist.messages.find((m) => (m.text || "").includes(marker));
if (!msg) throw new Error(`Marker not found: ${marker}`);
const dashed = msg.ts.replace(".", "-");
console.log(`https://test.events.iterate.com/streams/agents/slack/ts-${dashed}/?renderer=raw-pretty&composer=json`);
console.log(`https://agents.test.iterate-dev-jonas.app/streams/%2Fagents%2Fslack%2Fts-${dashed}`);
NODE
'
```

## GitHub Test

Use a PR in the test repo and mention the GitHub App slug:

```bash
doppler run -- bash -lc '
set -euo pipefail
MARKER="github-proof-$(date +%s)"
OWNER="${CHANNEL_TEST_GITHUB_REPO%%/*}"
REPO="${CHANNEL_TEST_GITHUB_REPO#*/}"
PR="${CHANNEL_TEST_GITHUB_PR_NUMBER}"
curl -fsS -X POST "https://api.github.com/repos/${OWNER}/${REPO}/issues/${PR}/comments" \
  -H "authorization: Bearer ${CHANNEL_TEST_GITHUB_USER_TOKEN}" \
  -H "accept: application/vnd.github+json" \
  -H "x-github-api-version: 2022-11-28" \
  -d "{\"body\":\"@${CHANNEL_TEST_GITHUB_APP_SLUG} reply exactly marker ${MARKER}\"}" | jq .
echo "marker=${MARKER}"
echo "github=https://github.com/${CHANNEL_TEST_GITHUB_REPO}/pull/${PR}"
echo "events=https://test.events.iterate.com/streams/agents/github/pr-${OWNER}-${REPO}-${PR}/?renderer=raw-pretty&composer=json"
echo "agents=https://agents.test.iterate-dev-jonas.app/streams/%2Fagents%2Fgithub%2Fpr-${OWNER}-${REPO}-${PR}"
'
```

Expected external behavior: the installed GitHub App posts a PR comment.

## Linear Test

Use the configured test issue and mention the Linear bot name:

```bash
doppler run -- bash -lc '
set -euo pipefail
MARKER="linear-proof-$(date +%s)"
BODY="@jonasland reply exactly marker ${MARKER}"
curl -fsS -X POST "https://api.linear.app/graphql" \
  -H "authorization: ${CHANNEL_TEST_LINEAR_USER_API_KEY}" \
  -H "content-type: application/json" \
  -d "{\"query\":\"mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }\",\"variables\":{\"input\":{\"issueId\":\"${CHANNEL_TEST_LINEAR_ISSUE_ID}\",\"body\":\"${BODY}\"}}}" | jq .
echo "marker=${MARKER}"
echo "issue=${CHANNEL_TEST_LINEAR_ISSUE_IDENTIFIER}"
echo "events=https://test.events.iterate.com/streams/agents/linear/issue-${CHANNEL_TEST_LINEAR_ISSUE_ID}/?renderer=raw-pretty&composer=json"
echo "agents=https://agents.test.iterate-dev-jonas.app/streams/%2Fagents%2Flinear%2Fissue-${CHANNEL_TEST_LINEAR_ISSUE_ID}"
'
```

Expected external behavior: the Linear app actor comments on the same issue.

## Discord Test

Canonical proof: use Discord in the browser and send a normal user message
mentioning the bot in the configured channel.

With the user's logged-in Chrome session:

```bash
agent-browser connect 9222
agent-browser tab list
agent-browser tab <discord-tab-id>
agent-browser snapshot -i
MARKER="discord-browser-$(date +%s)"
agent-browser fill <message-textbox-ref> "<@1498397463579594883> reply exactly marker ${MARKER}"
agent-browser press Enter
```

Use the explicit bot user mention id `<@1498397463579594883>`. Typing
`@iterate-test` can resolve to a role mention (`<@&...>`) instead, which creates
a real Discord message but does not necessarily trigger the bot mention filter.

Bot self-posting is useful only for checking the Discord REST token. It may be
ignored by gateway filtering and should not be treated as end-to-end proof.

REST token smoke:

```bash
doppler run -- bash -lc '
set -euo pipefail
MARKER="discord-proof-$(date +%s)"
MESSAGE_ID=$(curl -fsS -X POST "https://discord.com/api/v10/channels/${CHANNEL_TEST_DISCORD_CHANNEL_ID}/messages" \
  -H "authorization: Bot ${CHANNEL_TEST_DISCORD_APP_BOT_TOKEN}" \
  -H "content-type: application/json" \
  -d "{\"content\":\"<@${CHANNEL_TEST_DISCORD_BOT_USER_ID}> reply exactly marker ${MARKER}\"}" | jq -r .id)
echo "marker=${MARKER}"
echo "events=https://test.events.iterate.com/streams/agents/discord/thread-${CHANNEL_TEST_DISCORD_CHANNEL_ID}-${MESSAGE_ID}/?renderer=raw-pretty&composer=json"
echo "agents=https://agents.test.iterate-dev-jonas.app/streams/%2Fagents%2Fdiscord%2Fthread-${CHANNEL_TEST_DISCORD_CHANNEL_ID}-${MESSAGE_ID}"
'
```

A bot-to-self message may be ignored depending on gateway filtering. The
stronger proof is a browser/manual message from a real user in the channel.

## Common Failures

- No raw event: platform webhook/gateway is not configured or app credentials
  are stale.
- Raw event but no `agent-input-added`: channel rewrite processor failed.
- `agent-input-added` but no `events.iterate.com/agent/request-started`: agent app subscription or
  direct process kickoff failed.
- `codemode-block-added` but no external response: channel provider credentials
  or SDK/API call failed.
- Duplicate replies: stale subscriptions exist on old streams; use a fresh
  thread or recreate the project.
