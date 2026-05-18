---
name: debug-os-worker
description: Debug failures in the Cloudflare OS2 worker using the Cloudflare MCP server. Use when diagnosing 500s, missing logs, or request-level regressions in production or preview.
publish: false
---

# Debug OS2 Worker

Debug production/preview issues in the Cloudflare worker deployed from `apps/os2`.

## Workflow

1. Query recent Worker observability events.
2. Filter by trigger, message, requestId, or error text.
3. Quantify scope and correlate with deploy/ref.
4. Return evidence + next code path under `apps/os2/src/`.

## Defaults

- Start with the deployed service name for the environment (often `os2` in preview/dev; confirm in Cloudflare dashboard).
- Start with last 30 minutes; widen to 60m, then 3h if empty.

## Steps

### 1) Baseline events query

Use Cloudflare observability MCP tools with:

- `view: "events"`
- filter on service name when available
- limit 20–50

Collect real values for trigger, message, error, requestId, level.

### 2) Error-focused query

Filter on error level or distinctive message fragments from the alert.

### 3) Code correlation

Map failures to handlers under:

- `apps/os2/src/entry.workerd.ts`
- `apps/os2/src/orpc/`
- `apps/os2/src/domains/`

## Notes

- Legacy `apps/os` and machine/daemon control-plane paths were removed from this repo.
- Prefer Worker logs + PostHog error tracking over Fly SSH or container logs.
