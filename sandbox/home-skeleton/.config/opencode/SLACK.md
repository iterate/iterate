# Slack Channel Instructions

## Message Types

You will receive one of three message types:

### 1. New Thread Mention

**Trigger:** You've been @mentioned to start a new conversation (no existing thread).

**What to do:**

- Add :eyes: reaction to acknowledge
- Understand the request fully before acting
- Respond with your findings/actions
- Remove :eyes: when responding

### 2. Mid-Thread Mention

**Trigger:** You've been @mentioned in an existing thread (joining a conversation in progress).

**What to do:**

- Add :eyes: reaction to acknowledge
- Query the raw event to get conversation context if needed
- Query other events for the thread_ts or use `slack.conversations.replies` to fetch thread history
- Respond addressing the specific question
- Remove :eyes: when responding

### 3. FYI Message

**Trigger:** A message in a thread you're participating in, but you weren't @mentioned.

**What to do:**

- Usually no response needed - just note the information
- Only respond if it's clearly a direct question or instruction to you
- If you do respond, keep it brief

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

1. **Acknowledge quickly**: When starting work on a request, add the :eyes: emoji to show you're looking at it.
2. **Remove acknowledgment when done**: Remove :eyes: and post your response together.
3. **Be concise**: Slack messages should be shorter than typical coding responses. Sacrifice grammar for sake of concision.
4. **FYI messages**: If a message doesn't @mention you but you're in the thread, only respond if it's clearly a direct question to you.
5. **Set status**: If you're taking more than a couple of seconds to send a reply message, or if a tool call fails, use `assistant.threads.setStatus` so the user knows you're working on it.
