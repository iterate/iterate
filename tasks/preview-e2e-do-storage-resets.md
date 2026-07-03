---
state: todo
priority: high
size: medium
tags: [os, e2e, ci, cloudflare, durable-objects]
---

# Preview e2e: Cloudflare DO storage resets ("object was reset") on fresh slots

Since ~2026-07-03, preview e2e runs intermittently fail with a
Cloudflare-server-side error surfaced through capnweb:

```
Error: Internal error while starting up Durable Object storage caused object to be reset; reference = <id>
```

This is now the dominant preview-CI failure mode after the post-deploy 522
class was removed (PR #1622: routes are ensure-only + verified, slot
teardowns park). It is NOT route-related: the request reaches the Durable
Object (a zombie route never would), and the error is thrown during DO
storage startup on Cloudflare's side.

## Evidence (2026-07-03, preview-4, PR #1623 — two runs on identical code)

- Run 1 (fresh slot, first deploy): 9 tests failed across 4 files
  (itx / project-ingress / stream-lifecycle), 68 passed. Every failure was
  the storage-reset error, each with a different reference id. The failing
  tests ROTATED — different DOs each time.
- Run 2 (same code, redeploy): the sequential onboarding smoke — a single,
  non-concurrent create — failed with the same error ~2s in. No stampede
  involved.
- Minutes later, the identical smoke passed twice in a row run manually
  against the same slot (`doppler run --project os --config preview_4 --
pnpm exec tsx e2e/vitest/onboarding-smoke.ts`, project created in 4.1s,
  full agent turn). So the failure is transient and CF-side, not
  deterministic in our code.
- Same-day fleet context: PR #1594's preview e2e failed with a DIFFERENT
  (non-storage) signature while #1603 passed — rotating multi-family flake
  across unrelated branches.

## Possibly related

- `tasks/streams-event-delivery-flake-under-concurrent-load.md` (the
  concurrency-race family; distinct signature but same "slot under load"
  neighbourhood).
- `tasks/raise-e2e-maxconcurrency.md` — historical "Durable Object storage
  operation exceeded timeout" at high create concurrency; the reset error
  also clusters right after deploys, when DO workers were just replaced and
  objects are (re)starting.

## Ideas

- Correlate failures with deploy timing: do resets cluster in the first
  N seconds after the DO workers' scripts are replaced? If so, a short
  post-deploy settle (or a create-retry on this specific error string in
  test fixtures only) may be the pragmatic fix.
- Check Workers Observability / `wrangler tail` on a failing run for the
  matching reference ids; open a Cloudflare ticket with them if it keeps
  recurring — "Internal error" + reference id is their escalation format.
- Watch whether frequency drops once slots are all parked (post-#1622
  steady state): parked slots mean far fewer fresh-namespace first-touches.
