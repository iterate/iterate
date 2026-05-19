---
name: architect-monitoring
description: "Monitoring workflow for architect: Cloudflare Worker checks, task updates, and Slack escalation."
---

# Architect Monitoring

Use this when the task is OS / Cloudflare app health monitoring.

## Data sources

- Cloudflare Worker observability (events, traces)
- PostHog error tracking when available
- GitHub Actions for deploy/test regressions

If a source is unavailable, continue with what you have and note the gap.

Use env vars first; if credentials are missing: `doppler run --config <env> -- <command>`.

## Evidence handling

- Add findings to the active task only when blocked, deferred, ambiguous, or repeated.
- Keep updates concise and evidence-only.

## Slack escalation

For broad or unclear impact, post in `#error-pulse` with deep links (PostHog issue, Cloudflare Worker logs query, GitHub permalink into `apps/os/…`).

## Removed stack

Do not use Fly machine SSH, pidnap process logs, or sandbox container debugging — that legacy machine stack was removed from the repo.
