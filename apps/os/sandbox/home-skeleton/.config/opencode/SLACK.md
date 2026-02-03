# Slack Channel Instructions

## Message Types

### 1. New Thread Mention / Mid-Thread Mention

**Trigger:** You've been @mentioned.

**What to do:**

1. **IMMEDIATELY** acknowledge - react with :eyes: OR send a quick reply (for simple answers, just reply directly). Use `Promise.all` to do both if needed.
2. Do the work
3. Remove :eyes: when responding (if you added it)

### 2. FYI Message

**Trigger:** Message in thread you're in, but no @mention.

**What to do:** Usually ignore. Only respond if clearly directed at you.

## Files

You can't download and view files using the JS sdk. If there's a file attachment you need to read, use `curl` to download using the "private_url" field, for example:

```sh
curl -D /dev/stdout -H "Authorization: Bearer $SLACK_BOT_TOKEN" "https://files.slack.com/files-pri/T0123456789-F0123456789/something.jpg" -o /tmp/test_download.jpg
# check the file type - Slack responds with HTML if something went wrong with auth
file /tmp/test_download.jpg
head -1 /tmp/test_download.jpg
```

## Sending Replies

Use the `iterate tool slack` CLI command to interact with Slack. This gives you access to the full Slack Web API via a `slack` client object.

**Reply to a message:**

```bash
iterate tool slack 'await slack.chat.postMessage({
  channel: "CHANNEL_ID",
  thread_ts: "THREAD_TS",
  text: "Your response here",
})'
```

**Add a reaction:**

```bash
iterate tool slack 'await slack.reactions.add({
  channel: "CHANNEL_ID",
  timestamp: "MESSAGE_TS",
  name: "eyes",
})'
```

**Remove a reaction:**

```bash
iterate tool slack 'await slack.reactions.remove({
  channel: "CHANNEL_ID",
  timestamp: "MESSAGE_TS",
  name: "eyes",
})'
```

**Get thread history (for mid-thread context):**

```bash
iterate tool slack 'await slack.conversations.replies({
  channel: "CHANNEL_ID",
  ts: "THREAD_TS",
})'
```

**Set thread status**

When you think you'll need to perform some long running work, or when you're struggling with a task/it's taking a few extra attempts, update the thread status first so the slack user knows you're working on it:

```bash
iterate tool slack 'await slack.assistant.threads.setStatus({
  channel_id: "CHANNEL_ID",
  thread_ts: "THREAD_TS",
  status: "Parsing the file with foobar_tool...",
})'
```

You can use any method from the Slack Web API. The `slack` object is an instance of `@slack/web-api` WebClient.

## Inspecting Raw Events

The raw Slack webhook payload is stored in SQLite. To inspect it (useful for files, attachments, reactions, etc.):

```bash
sqlite3 $ITERATE_REPO/apps/daemon/db.sqlite "SELECT payload FROM events WHERE id='EVENT_ID'"
```

## Handling Files and Attachments

If a message contains files or attachments, query the raw event to get file URLs. When downloading files from Slack:

- Use `slack.token` to get the auth token for authenticated requests
- Follow redirects when downloading

## Best Practices

1. **Acknowledge IMMEDIATELY**: First tool call when @mentioned must acknowledge - either :eyes: reaction or a quick reply. No reading files or thinking first.
2. **Be concise**: Shorter than typical coding responses.
3. **Set status**: For long-running work, use `assistant.threads.setStatus`.
