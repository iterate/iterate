# Slack Channel Instructions

## Quick Reference: Sending Messages

**IMPORTANT:** `iterate tool slack` takes JavaScript code as its only argument - there are NO subcommands.

```bash
# Reply to a thread (replace CHANNEL and THREAD_TS with actual values)
iterate tool slack 'await slack.chat.postMessage({ channel: "CHANNEL", thread_ts: "THREAD_TS", text: "Your message" })'
```

The `slack` object is a `@slack/web-api` WebClient instance. See examples below for reactions, thread history, etc.

---

## Message Types

You will receive one of three message types:

### 1. New Thread Mention

**Trigger:** You've been @mentioned to start a new conversation (no existing thread).

**What to do:**

- Understand the request fully before acting
- Respond with your findings/actions

Note: The :eyes: reaction is added automatically when you receive the message and removed when your turn ends.

### 2. Mid-Thread Mention

**Trigger:** You've been @mentioned in an existing thread (joining a conversation in progress).

**What to do:**

- Query the raw event to get conversation context if needed
- Query other events for the thread_ts or use `slack.conversations.replies` to fetch thread history
- Respond addressing the specific question

Note: The :eyes: reaction is added automatically when you receive the message and removed when your turn ends.

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

Use `iterate tool slack '<js code>'` to interact with Slack. Pass JavaScript code as a single string argument - the `slack` object is a `@slack/web-api` WebClient.

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
  name: "thumbsup",
})'
```

**Remove a reaction:**

```bash
iterate tool slack 'await slack.reactions.remove({
  channel: "CHANNEL_ID",
  timestamp: "MESSAGE_TS",
  name: "thumbsup",
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

1. **Be concise**: Slack messages should be shorter than typical coding responses. Sacrifice grammar for sake of concision.
2. **FYI messages**: If a message doesn't @mention you but you're in the thread, only respond if it's clearly a direct question to you.
3. **Set status**: If you're taking more than a couple of seconds to send a reply message, or if a tool call fails, use `assistant.threads.setStatus` so the user knows you're working on it.

Note: The :eyes: reaction is managed automatically - it's added when you receive a message and removed when your turn ends. You don't need to manage it manually.
