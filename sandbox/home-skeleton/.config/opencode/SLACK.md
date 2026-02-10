# Slack Channel Instructions

## Hard Rule: CLI Shape

`iterate tool slack` takes one arg: JS code.
`slack` is a `@slack/web-api` `WebClient`.

```bash
# valid
iterate tool slack 'await slack.chat.postMessage({ channel: "C123", thread_ts: "1234.5678", text: "hi" })'

# invalid! ERROR!!!!
iterate tool slack send --channel C123 --thread_ts 1234.5678 --text "hi"
iterate tool slack --channel C123
iterate tool slack postMessage ...
```

## Message Types

1. New thread `@mention`: understand ask, reply in thread.
2. Mid-thread `@mention`: fetch context via `slack.conversations.replies`; query raw event/related events for `thread_ts` when needed; reply to exact ask.
3. FYI (no `@mention`): usually no reply; reply only for direct ask/instruction; keep brief.

`:eyes:` reaction is auto-managed.

## Common Commands

Reply:

```bash
iterate tool slack 'await slack.chat.postMessage({
  channel: "CHANNEL_ID",
  thread_ts: "THREAD_TS",
  text: "Your response",
})'
```

Add reaction:

```bash
iterate tool slack 'await slack.reactions.add({
  channel: "CHANNEL_ID",
  timestamp: "MESSAGE_TS",
  name: "thumbsup",
})'
```

Remove reaction:

```bash
iterate tool slack 'await slack.reactions.remove({
  channel: "CHANNEL_ID",
  timestamp: "MESSAGE_TS",
  name: "thumbsup",
})'
```

Thread history:

```bash
iterate tool slack 'await slack.conversations.replies({
  channel: "CHANNEL_ID",
  ts: "THREAD_TS",
})'
```

## Types and Docs

WebClient TypeScript source: https://github.com/slackapi/node-slack-sdk/blob/main/packages/web-api/src/WebClient.ts

Inspect types locally:

```bash
pnpm --dir "${ITERATE_REPO:-$PWD}/apps/os" exec node -p "require.resolve('@slack/web-api/dist/methods.d.ts')"
```

## `Promise.all` for parallel calls

List replies while posting a "searching" response:

```bash
iterate tool slack 'const [replies, sent] = await Promise.all([
  slack.conversations.replies({ channel: "CHANNEL_ID", ts: "THREAD_TS" }),
  slack.chat.postMessage({
    channel: "CHANNEL_ID",
    thread_ts: "THREAD_TS",
    text: "Looking now :mag:",
  }),
]);'
```

Post response and remove reaction at same time:

```bash
iterate tool slack 'await Promise.all([
  slack.chat.postMessage({
    channel: "CHANNEL_ID",
    thread_ts: "THREAD_TS",
    text: "Done. Applied fix.",
  }),
  slack.reactions.remove({
    channel: "CHANNEL_ID",
    timestamp: "MESSAGE_TS",
    name: "eyes",
  }),
]);'
```

## Files

You can't download and view files using the JS sdk. If there's a file attachment you need to read, use `curl` to download using the "private_url" field, for example:

```sh
curl -D /dev/stdout -H "Authorization: Bearer $SLACK_BOT_TOKEN" "https://files.slack.com/files-pri/T0123456789-F0123456789/something.jpg" -o /tmp/test_download.jpg
# check the file type - Slack responds with HTML if something went wrong with auth
file /tmp/test_download.jpg
head -1 /tmp/test_download.jpg
```

## Raw Events

Slack webhook payloads are in SQLite:

```bash
sqlite3 $ITERATE_REPO/apps/daemon/db.sqlite "SELECT payload FROM events WHERE id='EVENT_ID'"
```

## Best Practices

1. **Be concise**: Slack messages should be shorter than typical coding responses. Sacrifice grammar for sake of concision.
2. **FYI messages**: If a message doesn't @mention you but you're in the thread, only respond if it's clearly a direct question to you.

Note: The :eyes: reaction and thread status are managed automatically. You don't need to manage them manually.
