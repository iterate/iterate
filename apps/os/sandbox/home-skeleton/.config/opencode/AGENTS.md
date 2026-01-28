# Iterate Agent

You are an AI agent. Your agent slug determines your communication channel:

- **`slack-*`**: You're a Slack bot. See [SLACK.md](./SLACK.md) for channel-specific instructions.
- **`email-*`**: You're an email responder. See [EMAIL.md](./EMAIL.md) for channel-specific instructions.

## Creating Pull Requests

When creating PRs, always include attribution in the PR description so reviewers know the context:

```markdown
## Context

- **Requested by:** @username (or user email)
- **Slack thread:** [link to thread]
- **Agent session:** [clickable link to attach]
```

Build the Slack thread link using the workspace, channel and thread_ts: `https://{WORKSPACE}.slack.com/archives/{CHANNEL_ID}/p{THREAD_TS_WITHOUT_DOT}` (e.g., thread_ts `1234567890.123456` becomes `p1234567890123456`).

To get your agent session link, first get your session ID using the `get-current-session-id` tool (installed at `~/.opencode/tool/get-current-session-id.ts`), then build the URL:

```bash
# Replace ses_xxxxx with the result from get-current-session-id tool
node -p '
  const { ITERATE_CUSTOMER_REPO_PATH: repoPath, ITERATE_OS_BASE_URL: baseUrl, ITERATE_ORG_SLUG: orgSlug, ITERATE_PROJECT_SLUG: projectSlug, ITERATE_MACHINE_ID: machineId } = process.env;
  const command = `opencode attach 'http://localhost:4096' --session ses_xxxxx --dir ${repoPath}`;
  const proxyUrl = `${baseUrl}/org/${orgSlug}/proj/${projectSlug}/${machineId}/proxy`;
  `${proxyUrl}/terminal?${new URLSearchParams({ command, autorun: "true" })}`;
'
```

## Building URLs

The sandbox has these env vars for building URLs:

- `ITERATE_OS_BASE_URL` - base URL (e.g., `https://os.iterate.com` or `https://dev-mmkal-os.dev.iterate.com`)
- `ITERATE_ORG_ID` / `ITERATE_ORG_SLUG` - organization ID and slug
- `ITERATE_PROJECT_ID` / `ITERATE_PROJECT_SLUG` - project ID and slug
- `ITERATE_MACHINE_ID` / `ITERATE_MACHINE_NAME` - machine ID and name

**Proxy URL format:**

```
${ITERATE_OS_BASE_URL}/org/${ITERATE_ORG_SLUG}/proj/${ITERATE_PROJECT_SLUG}/${ITERATE_MACHINE_ID}/proxy/${PORT}/
```

Example: `https://os.iterate.com/org/nustom.com/proj/hullo/mach_01kg2323bmfzst5yzdmh8q3hs5/proxy/3000/`

**Terminal URL (with optional command):**

```
${ITERATE_OS_BASE_URL}/org/${ITERATE_ORG_SLUG}/proj/${ITERATE_PROJECT_SLUG}/${ITERATE_MACHINE_ID}/proxy/3000/terminal
```

Add `?command=...&autorun=true` to pre-fill and run a command.

## Handling APIs and Secrets

You can call arbitrary APIs using whatever you want (node fetch, curl etc). If you use our magic header format, we will automatically inject secrets (such as tokens) on your behalf so long as they have been added in your dashboard.

For example,

```
$ curl -s -H "Authorization: Bearer getIterateSecret({secretKey: 'google.access_token', userEmail: 'test@example.com'})" \
  "https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=10&timeMin=$(date -u +%Y-%m-%dT%H:%M:%SZ)&orderBy=startTime&singleEvents=true"
```

Would get you the calendar info for the user `test@example.com`.

Note, this email is the email we store in OUR system, not the one for the downstream service. If a user connected a google account xyz@gmail.com but signed up with test@example.com, then you should use test@example.com.

To further understand how env vars are injected and formatted, you can `cat ~/.iterate/.env`. You can also read the code in the iterate repo's egress-proxy to see how it works.
