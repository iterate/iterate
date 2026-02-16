# Webchat Channel Instructions

## Hard Rule: CLI Shape

Use `iterate tool exec-js` using `webchat`.

```bash
# valid
iterate tool exec-js 'await webchat.postMessage({ threadId: "THREAD_ID", text: "hi" })'

# invalid
iterate tool webchat ...
iterate tool webchat send --thread-id THREAD_ID --body "hi"
```

## Quick Reference

```bash
iterate tool exec-js 'await webchat.postMessage({ threadId: "THREAD_ID", text: "Your response here" })'
```

`webchat` methods:

```ts
interface WebchatClient {
  postMessage(params: {
    threadId: string;
    text?: string;
    attachments?: Array<{ fileName: string; filePath: string; mimeType?: string; size?: number }>;
  }): Promise<{ success: boolean; threadId: string; messageId: string; eventId: string }>;
  addReaction(params: {
    threadId: string;
    messageId: string;
    reaction: string;
  }): Promise<{ success: boolean; eventId: string }>;
  removeReaction(params: {
    threadId: string;
    messageId: string;
    reaction: string;
  }): Promise<{ success: boolean; eventId: string }>;
  getThreadMessages(params: { threadId: string }): Promise<{
    threadId: string;
    messages: Array<{
      threadId: string;
      messageId: string;
      role: string;
      text: string;
      createdAt: number;
    }>;
  }>;
  listThreads(): Promise<{
    threads: Array<{
      threadId: string;
      title: string;
      messageCount: number;
      lastMessageAt: number;
    }>;
  }>;
}
```

## Message Types

You will receive either:

1. New thread: user started a new webchat thread.
2. Reply in existing thread: follow-up in a thread you're already in.

Always reply with `webchat.postMessage(...)`.

## Sending Replies

Reply:

```bash
iterate tool exec-js 'await webchat.postMessage({
  threadId: "THREAD_ID",
  text: "Your response here",
})'
```

Add reaction:

```bash
iterate tool exec-js 'await webchat.addReaction({
  threadId: "THREAD_ID",
  messageId: "MESSAGE_ID",
  reaction: "thumbsup",
})'
```

Remove reaction:

```bash
iterate tool exec-js 'await webchat.removeReaction({
  threadId: "THREAD_ID",
  messageId: "MESSAGE_ID",
  reaction: "thumbsup",
})'
```

Thread history:

```bash
iterate tool exec-js 'const result = await webchat.getThreadMessages({ threadId: "THREAD_ID" }); console.log(JSON.stringify(result, null, 2));'
```

## Inspecting Raw Events

The raw webchat payload is stored in SQLite:

```bash
sqlite3 $ITERATE_REPO/apps/daemon/db.sqlite "SELECT payload FROM events WHERE id='EVENT_ID'"
```

## Sending Files

```bash
iterate tool exec-js 'await webchat.postMessage({
  threadId: "THREAD_ID",
  text: "Here is the generated image:",
  attachments: [{ fileName: "output.png", filePath: "/tmp/output.png", mimeType: "image/png" }],
})'
```

The UI shows previews for images and download links for other files.

## Receiving Files

User uploads are written to `/tmp/webchat-uploads/` and listed in incoming message attachments.

## Best Practices

1. Be concise.
2. Markdown is supported.
3. Always respond through `webchat.postMessage`, not assistant output.
4. Include `mimeType` on file attachments.
