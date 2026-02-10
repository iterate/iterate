---
name: debug-os-worker
description: Debug failures in the Cloudflare `os` worker using the Cloudflare MCP server (events, keys, values, and targeted queries). Use when diagnosing 500s, missing logs, daemon/control-plane issues, or request-level regressions in production.
publish: false
---

# Debug OS Worker

Debug production control-plane issues in the Cloudflare `os` worker.

## Workflow

1. Use the `os` worker only (no worker-name discovery step).
2. Pull recent `events` first, then filter.
3. Identify exact failing trigger/message/requestId.
4. Quantify scope with calculations.
5. Return evidence + next code path to inspect.

## Steps

### 1) Worker + timeframe defaults

- Worker is always `os`.
- Start with last 30 minutes.
- If empty/noisy, move to 60m, then 3h.

### 2) Baseline query (events)

- Run `user-cloudflare-query_worker_observability` with:
  - `view: "events"`
  - filter `$metadata.service == "os"` (if key exists)
  - limit 20-50
- Goal: collect real values for:
  - `$metadata.trigger`
  - `$metadata.message`
  - `$metadata.error`
  - `$metadata.requestId`
  - `$metadata.level`

### 3) Error-focused query

- Add one of:
  - `$metadata.error exists`
  - `$metadata.level == "error"` (or observed level value)
  - `$metadata.message includes "<observed failure substring>"`
- Use concrete values from baseline results. Do not guess keys/values.

If you have a daemon-side correlation id or `cf-ray`, search for it in message/request-id fields.

### 4) Verify keys/values only when needed

- If a filter fails or returns nothing:
  - call `user-cloudflare-observability_keys`
  - call `user-cloudflare-observability_values` for the exact key
- Then retry with exact returned value.

### 5) Scope query (calculations)

- Use `view: "calculations"` for:
  - total error count in timeframe
  - grouped counts by trigger or message
- Keep group-bys small. Use only verified keys.

### 6) Optional live tail with Doppler (outside MCP)

Use only when you need live correlation during an active incident:

`doppler run --config prd -- npx wrangler tail os --format json`

Use MCP for historical triage; use tail for real-time confirmation.

## Hard Rules

- Always debug `os`, not other workers.
- Start with `events` before `calculations`.
- Prefer `includes` over `regex` unless required.
- Keep queries iterative (small steps, short timeframe first).
- If zero results, widen time before adding complexity.

## Output Format

Return:

1. Failing path: trigger/message/error signature.
2. Scope: count + timeframe (+ grouped breakdown if useful).
3. Evidence: requestId/cf-ray/message excerpts.
4. Most likely backend code path to inspect next.

## Notes

- Dashboard deep-link for manual checks:
  - `https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/workers/services/view/os/production/observability/events`
