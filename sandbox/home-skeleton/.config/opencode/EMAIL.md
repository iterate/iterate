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

Use `iterate tool exec-js` using `sendEmail(...)`.

```bash
iterate tool exec-js 'await sendEmail({
  to: "sender@example.com",
  subject: "Re: Original Subject",
  text: "Your response here",
})'
```

With HTML:

```bash
iterate tool exec-js 'await sendEmail({
  to: "sender@example.com",
  subject: "Re: Original Subject",
  text: "Your response here",
  html: "<p>Your <strong>formatted</strong> response here</p>",
})'
```

`sendEmail` uses `ITERATE_RESEND_FROM_ADDRESS` by default and sends from `Iterate Agent <...>`.

If needed, use raw Resend client via `resend`.

## Inspecting Raw Events

The raw email webhook payload is stored in SQLite:

```bash
sqlite3 $ITERATE_REPO/apps/daemon/db.sqlite "SELECT payload FROM events WHERE id='EVENT_ID'"
```

## Best Practices

1. Be concise.
2. Briefly quote context when replying.
3. Prefer plain text unless HTML adds real value.
4. Keep subject threading (`Re:`) consistent.
