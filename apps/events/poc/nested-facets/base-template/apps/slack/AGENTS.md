# Slack App

Bidirectional bridge between Slack and agent streams.

## Architecture

```
Slack webhook → POST /api/webhook → eyes emoji + agent-input-added → agent stream
Agent (CodeMode) → slack.replyToThread({ channel, threadTs, text }) → Slack
Agent (CodeMode) → slack.reactToMessage({ channel, messageTs, emoji }) → Slack
```

Single DO class (`App`). No facets, no stream processors. Webhook handler does everything synchronously.

## Setup

1. Create Slack app at api.slack.com/apps (from manifest or manually)
2. Bot scopes: `app_mentions:read`, `channels:history`, `im:history`, `chat:write`, `reactions:read`, `reactions:write`
3. Event subscriptions: `app_mention`, `message.channels`, `message.im`, `reaction_added`, `reaction_removed`
4. Set Request URL to `https://slack.<project>.iterate-dev-jonas.app/api/webhook`
5. Install to workspace, copy bot token
6. Run: `POST /api/install` with `{ projectSlug, eventsBaseUrl, slackBotToken }`

## Debugging

### Tokens

- **jonasland bot token**: stored via `/api/install` in the Slack app's config table
- **CI bot token** (for testing): `SLACK_CI_BOT_TOKEN` in doppler `os` project, dev config. Use this to post test messages as a different bot that @mentions jonasland.
- **OS slack tokens**: `doppler run --config dev -- env | grep SLACK`

### Testing the pipeline

```bash
# Post a test message (from CI bot, mentioning jonasland bot)
curl -X POST "https://slack.com/api/chat.postMessage" \
  -H "Authorization: Bearer $SLACK_CI_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel":"C08R1SMTZGD","text":"<@U0B0214F274> what is 2+2?"}'

# Check agent stream (replace ts)
curl "https://<project>.events.iterate.com/api/streams/%2Fagents%2Fslack%2Fts-<ts-dashed>"

# Check agents processor events
curl "https://agents.<project>.iterate-dev-jonas.app/streams/%2Fagents%2Fslack%2Fts-<ts-dashed>/api/events"

# Direct RPC test
curl -X POST "https://slack.<project>.iterate-dev-jonas.app/api/rpc/replyToThread" \
  -H "Content-Type: application/json" \
  -d '{"channel":"C08R1SMTZGD","threadTs":"<ts>","text":"test"}'
```

### Common issues

- **"No thread mapping"**: Old code. Rebuild the slack app — the current version uses `channel+threadTs` directly, no lookup table.
- **Duplicate replies**: Stale event subscriptions from prior deploys. Use a fresh project or clean up subscriptions on events.iterate.com.
- **Bot loop**: Bot's own messages should be filtered by `parseWebhookPayload` (checks `event.user === botUserId` and `bot_profile`). If looping, check that the webhook payload includes `authorizations` with `is_bot: true`.
- **Rebase not updating files**: Force rebase may fail silently on recreated projects. Upload files directly via `PUT /api/files/<path>`.
- **Subscription race**: The webhook handler appends `slack:thread-opened` first (creates stream, triggers auto-subscribe), waits 5s, then appends `agent-input-added`. If the agents app takes >5s to subscribe, the event is missed.

### Key IDs

- Channel #test-blank: `C08R1SMTZGD`
- jonasland bot user: `U0B0214F274`
- Slack workspace: `T0675PSN873`
