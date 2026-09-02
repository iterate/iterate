---
status: in-progress
size: small
---

# artifacts-gc: cursor-continue sweep + older legacy name schemes

## Status summary

Follow-up to #2565, prompted by the first real backfill pass (2026-09-02).

- Done: nothing yet — spec below.
- Missing: both changes + tests.

## Problems observed on the first drain pass

1. **Quadratic re-walking + inflated counters.** The sweep restarts its
   listing from the head after every page that deleted anything (the original
   cursor-invalidation paranoia). Skipped repos compact toward the head of
   the oldest-first listing as orphans around them are deleted, so each
   restart re-walks — and re-counts — the whole skipped prefix.
   `preview_3` reported `skippedForeign: 276994` in a 5000-delete run whose
   namespace holds nowhere near that; the real foreign count is the ~5–10k
   the restarts multiplied. ~28% of the run's API calls were redundant list
   pages, from a shared 1200-req/5-min account budget, and the overhead grows
   as the deletable share shrinks.

2. **Two older name schemes are unrecognized** (so never reclaimed):
   - `repo-<hex>` — hex of `<id>:<path>`, e.g. decodes to
     `__null__:/repos/iterate-config-base` (~2.3k on preview_2 alone).
   - `proj__os__<ulid>--<suffix>` — the pre-`prj_<hex>` project id format;
     liveness-checkable against the directory KV exactly like current ids.

## Fixes

- **Always continue the cursor, never restart.** We only delete entries at or
  before the cursor's position in the `created_at`-ascending order, so
  forward iteration is unaffected; worst case a stale cursor skips entries,
  and the next run's fresh listing self-heals (same story as failed deletes).
  Counters become walk-once accurate.
- **Extend triage:** recognize `proj__<app>__<id>` leading ids (KV liveness
  check as usual) and decode `repo-<hex>` (id `__null__` → global-scope
  handling; other ids → KV liveness check). Anything else stays untouched.

## Checklist

- [ ] cursor-continue sweep (no restart-from-head; drop the now-dead branch)
- [ ] triage: `proj__*__` ids
- [ ] triage: `repo-<hex>` decode
- [ ] tests for the new shapes; existing tests stay green
- [ ] live read-only validation (dry-run walks each page once)

## Implementation log

(added as work proceeds)
