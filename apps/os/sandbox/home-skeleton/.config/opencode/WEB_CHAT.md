# Web Chat Channel Instructions

## Quick Reference: Sending Messages

**IMPORTANT:** `iterate tool webchat` takes JavaScript code as its only argument — there are NO subcommands.

```bash
# Reply in a thread (replace THREAD_ID with actual value from the incoming message)
iterate tool webchat 'await webchat.postMessage({ threadId: "THREAD_ID", text: "Your response here" })'
```

The `webchat` object is an HTTP client with these methods:

```ts
interface WebChatClient {
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

---

## Message Types

You will receive one of two message types:

### 1. New Thread

**Trigger:** A user started a new web chat thread.

**What to do:**

- Read and understand the request
- Perform the requested work
- Reply with your findings/actions

### 2. Reply in Existing Thread

**Trigger:** A follow-up message in a thread you're already participating in.

**What to do:**

- Note the new information or request
- Continue the conversation as appropriate
- Reply addressing the specific question or update

## Sending Replies

**Reply to a thread:**

```bash
iterate tool webchat 'await webchat.postMessage({
  threadId: "THREAD_ID",
  text: "Your response here",
})'
```

**Add a reaction:**

```bash
iterate tool webchat 'await webchat.addReaction({
  threadId: "THREAD_ID",
  messageId: "MESSAGE_ID",
  reaction: "thumbsup",
})'
```

**Remove a reaction:**

```bash
iterate tool webchat 'await webchat.removeReaction({
  threadId: "THREAD_ID",
  messageId: "MESSAGE_ID",
  reaction: "thumbsup",
})'
```

**Get thread history (for context):**

```bash
iterate tool webchat 'const result = await webchat.getThreadMessages({ threadId: "THREAD_ID" }); console.log(JSON.stringify(result, null, 2))'
```

## Inspecting Raw Events

The raw web chat payload is stored in SQLite. To inspect it:

```bash
sqlite3 $ITERATE_REPO/apps/daemon/db.sqlite "SELECT payload FROM events WHERE id='EVENT_ID'"
```

## Sending Files

To send a file to the user, create the file anywhere on the filesystem, then include it as an attachment:

```bash
iterate tool webchat 'await webchat.postMessage({
  threadId: "THREAD_ID",
  text: "Here is the generated image:",
  attachments: [{ fileName: "output.png", filePath: "/tmp/output.png", mimeType: "image/png" }],
})'
```

The UI will show inline previews for images (jpeg, png, gif, webp) and view/download buttons for PDFs and other files. Any absolute path on the machine filesystem works.

## Receiving Files

When a user uploads files, the incoming message will list them under "Attachments:" with their file paths. The files are written to `/tmp/web-chat-uploads/` and you can read them directly:

```bash
cat /tmp/web-chat-uploads/abc123-photo.jpg
```

## Best Practices

1. **Be concise**: Web chat messages should be shorter than typical coding responses.
2. **Markdown supported**: The web chat UI renders markdown.
3. **Reply promptly**: Always use `webchat.postMessage` to reply — do not rely on your assistant output being shown directly.
4. **Include file metadata**: When sending files, include `mimeType` so the UI knows how to preview them.
