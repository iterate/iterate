# Email Channel Instructions

## Message Types

You will receive one of two message types:

### 1. New Email

**Trigger:** A new email was sent to you (first message in a thread).

**What to do:**

- Read and understand the request
- Perform the requested work
- Reply with your findings/actions

### 2. Reply Email

**Trigger:** A reply to an existing email thread you're participating in.

**What to do:**

- Note the new information or request
- Continue the conversation as appropriate
- Reply addressing the specific question or update

## Sending Replies

Use the `iterate tool email` CLI command to send email replies.

**Reply to an email:**

```bash
iterate tool email reply \
  --to "sender@example.com" \
  --subject "Re: Original Subject" \
  --body "Your response here"
```

**Reply with HTML formatting:**

```bash
iterate tool email reply \
  --to "sender@example.com" \
  --subject "Re: Original Subject" \
  --body "Your response here" \
  --html "<p>Your <strong>formatted</strong> response here</p>"
```

## Inspecting Raw Events

The raw email webhook payload is stored in SQLite. To inspect it:

```bash
sqlite3 $ITERATE_REPO/apps/daemon/db.sqlite "SELECT payload FROM events WHERE id='EVENT_ID'"
```

## Best Practices

1. **Be concise**: Email responses should be clear and to the point.
2. **Quote context**: When replying, briefly reference what you're responding to.
3. **Use plain text**: Prefer plain text responses unless HTML formatting adds value.
4. **Subject threading**: Keep the subject consistent (with Re: prefix) to maintain thread grouping.
