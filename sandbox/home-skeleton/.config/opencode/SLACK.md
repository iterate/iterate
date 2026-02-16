# Slack Channel Instructions

## Hard Rule: CLI Shape

Use `iterate tool exec-js` and write JavaScript that uses `slack`.
`slack` is a `@slack/web-api` `WebClient`.

```bash
# valid
iterate tool exec-js 'await slack.chat.postMessage({ channel: "C123", thread_ts: "1234.5678", text: "hi" })'

# invalid
iterate tool slack ...
iterate tool email ...
iterate tool webchat ...
```

## Message Types

1. New thread `@mention`: understand ask, reply in thread.
2. Mid-thread `@mention`: fetch context via `slack.conversations.replies`; query raw events for `thread_ts` when needed; reply to exact ask.
3. FYI (no `@mention`): usually no reply; reply only for direct ask/instruction; keep brief.

`:eyes:` reaction is auto-managed.

## Common Commands

Reply:

```bash
iterate tool exec-js 'await slack.chat.postMessage({
  channel: "CHANNEL_ID",
  thread_ts: "THREAD_TS",
  text: "Your response",
})'
```

Add reaction:

```bash
iterate tool exec-js 'await slack.reactions.add({
  channel: "CHANNEL_ID",
  timestamp: "MESSAGE_TS",
  name: "thumbsup",
})'
```

Remove reaction:

```bash
iterate tool exec-js 'await slack.reactions.remove({
  channel: "CHANNEL_ID",
  timestamp: "MESSAGE_TS",
  name: "thumbsup",
})'
```

Thread history:

```bash
iterate tool exec-js 'await slack.conversations.replies({
  channel: "CHANNEL_ID",
  ts: "THREAD_TS",
})'
```

## `Promise.all` for parallel calls

```bash
iterate tool exec-js 'const [replies, sent] = await Promise.all([
  slack.conversations.replies({ channel: "CHANNEL_ID", ts: "THREAD_TS" }),
  slack.chat.postMessage({
    channel: "CHANNEL_ID",
    thread_ts: "THREAD_TS",
    text: "Looking now :mag:",
  }),
]);'
```

```bash
iterate tool exec-js 'await Promise.all([
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

If you need to download Slack files, use `curl` with `SLACK_BOT_TOKEN` and the file `url_private`.

```sh
curl -D /dev/stdout -H "Authorization: Bearer $SLACK_BOT_TOKEN" "https://files.slack.com/files-pri/T0123456789-F0123456789/something.jpg" -o /tmp/test_download.jpg
file /tmp/test_download.jpg
head -1 /tmp/test_download.jpg
```

## Raw Events

Slack webhook payloads are in SQLite:

```bash
sqlite3 $ITERATE_REPO/apps/daemon/db.sqlite "SELECT payload FROM events WHERE id='EVENT_ID'"
```

## Best Practices

1. Be concise. Slack replies should be short.
2. FYI messages without `@mention` usually don't need a reply.
3. The `:eyes:` reaction and thread status are managed automatically.
