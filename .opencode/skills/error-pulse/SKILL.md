---
name: error-pulse
description: PostHog alert responder workflow with required Slack deep-links and escalation rules.
publish: false
---

# Error Pulse

Use this skill when responding to PostHog alerts.

Primary goal: close the alert with minimal human toil.

## Workflow

1. Investigate root cause first. Gather concrete evidence (logs, traces, failing checks, repro steps).
   - PostHog alert regressions are often in `~/src/github.com/iterate/iterate`; check that repo early unless evidence points elsewhere.
2. Classify:
   - **False positive / noisy alert**: tune threshold, filter expected errors, or suggest silencing with clear rationale.
   - **Real bug**: implement the smallest safe fix, add tests, open a PR.
3. Keep updates concise and action-oriented.

## Autonomous merge policy

You may merge autonomously only when all are true:

1. All required checks are green.
2. Cursor Bugbot labels risk as low (or equivalent low-risk finding).
3. No unresolved review comments remain.
4. Branch is mergeable without conflicts.

If any gate fails, do not merge.

## Slack escalation policy

If blocked, uncertain, or impact is broad, post in `#error-pulse` (`C09K1CTN4M7`) with evidence and clear asks.

- Use `@channel` for urgent incidents requiring immediate attention.
- Use `@here` for important but not time-critical issues.

When you open or continue a Slack thread, subscribe it to your current agent session so replies route back to you:

```bash
iterate tool subscribe-slack-thread --channel C09K1CTN4M7 --thread-ts <thread_ts> --session-id <session_id>
```

Use `get-current-session-id` tool to get `<session_id>`.

## Slack thread behavior

When you are subscribed to a thread, reply to questions and direct asks even if you are not @mentioned. The `#error-pulse` channel is an active incident channel - any questions which seem directed at you should be answered, excluding questions where someone else is @tagged.

## Slack message requirements

**CRITICAL: Every initial post to `#error-pulse` MUST include deep-links inline.** Do NOT post a summary first and add links later - include them in the very first message. This is non-negotiable.

Required deep-links:

- **PostHog**: link to the error tracking issue or event. The alert payload contains `posthogProjectId` and `$exception_issue_id` - use them to build `https://<host>/project/<id>/error_tracking/<issue_id>`.
- **Cloudflare Worker logs**: link to the Worker logs page with a pre-filled query for the error message when possible. Use a regex filter on `message`, URL-encode it, and include it in the very first Slack message. Example shape: `https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/workers/services/view/os/production/observability/events?...&filters=%5B%7B%22key%22%3A%22message%22%2C%22operation%22%3A%22regex%22%2C%22type%22%3A%22string%22%2C%22value%22%3A%22<url-encoded-regex-error-message>%22%7D%5D`
- **Source code**: GitHub permalink with line numbers (e.g. `https://github.com/iterate/iterate/blob/main/apps/os/backend/orpc/router.ts#L62`)

For the Cloudflare link, prefer the most specific stable regex you can derive from the alert text. Escape quotes and special regex characters when needed; if the raw error is too noisy, trim it down to the distinctive failure fragment before encoding it into the URL. If you cannot build a reliable pre-filled query, fall back to the normal Cloudflare Worker logs page and say that the filter could not be prefilled confidently.
