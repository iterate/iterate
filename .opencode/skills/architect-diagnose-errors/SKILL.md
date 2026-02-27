---
name: architect-diagnose-errors
description: Diagnose error spikes and exception clusters with Cloudflare + PostHog evidence.
---

# Diagnose Errors

Use when there are new/rising errors, 5xx spikes, or repeated failure signatures.

## Inputs

- Cloudflare Observability MCP (request failures, logs, latency/error trends)
- PostHog MCP (exception signatures, frequency, impacted users)
- Recent git commits/PRs (`git log`, `gh pr`) for regression correlation

## Workflow

1. Quantify incident window and top error signatures.
2. Group related failures into likely root-cause clusters.
3. Correlate onset with recent deploys/commits/config changes.
4. Propose smallest safe fix and confidence level.

## Output

- clustered signatures + impact
- evidence links/ids
- likely owner/code path
- best next action (fix now vs task follow-up)
