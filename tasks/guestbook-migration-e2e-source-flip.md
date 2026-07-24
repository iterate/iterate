status: in-progress
size: small

# Fix the guestbook-package-migration e2e source-flip race

## Status summary

Root cause diagnosed and reproduced locally (6/6 failures with warm build
caches). Fix: make the test simulate the pre-packaging world for real by
parking the project worker during the createApp phase. Remaining: verify with
the local repro loop, run checks, open PR.

## Problem

`apps/os/e2e/vitest/guestbook-package-migration.e2e.test.ts` fails in preview
CI with:

```
Error: stateful worker source changed for prj_….iterate/?durableWorkerKey=app-guestbook-stream
```

Two consecutive preview runs (PR #2304 job `40324m52df`, PR #2307 job
`jk3bm50zd7`) failed both the test and its retry. Fresh slots, fresh
projects — not stale state.

## Root cause

The test's premise — "the Durable Object is currently sourced from the
createApp ref" — cannot hold on a freshly seeded project. Since #2303, the
seeded config's project worker delivers **every committed stream event** to
the same stateful DO using the **packaged** ref
(`GuestbookApp.processEvent` → `worker.syncEvent(guestbookWorkerRef)`).

The test's `sign` via the createApp ref appends up to three events
(`guestbook/created`, `subscription-removed`, `entry-signed`). Each schedules
a delivery-with-packaged-ref to the same DO.
`StatefulWorkerDurableObject.#facet` aborts the hosted facet when the source
cache key flips, killing any in-flight call with exactly the observed error.
Whether the test passes is pure interleaving: cold worker builds spread the
calls out (test passes), warm build caches make the delivery land inside the
test's in-flight createApp calls (test fails). Reproduced locally: first run
after dev-server boot passes (~7.7s), every warm rerun fails (~1.8s).

## Fix

- [ ] Park the project worker before the createApp phase: commit a minimal
      `worker.ts` with no packaged-app delivery, so no packaged-ref
      invocations can race the createApp calls.
- [ ] Restore the original template `worker.ts` before the packaged phase —
      this restore IS the migration moment the test is about.
- [ ] Verify with the local repro loop (>= 6 warm runs).
- [ ] typecheck / lint / knip.

## Notes

- The product behavior (facet abort on source change, killing in-flight
  calls) is by design; internal stream delivery retries absorb it. Whether an
  external caller racing a live source flip should see a raw
  `stateful worker source changed` error — or the outer DO should drain
  in-flight calls before restarting the facet — is a product question left
  out of scope here.
- The playwright `seeded-apps` retry seen in #2307's run uses its own project
  and only ever invokes the DO with the packaged ref (no flip possible) —
  ordinary cold-build flake, not this mechanism.
