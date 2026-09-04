---
status: complete
size: small
---

# DO duration alerter: one daily thread, no false "FAILED", sane thresholds

## Status summary

Spec'd 2026-09-04 from the first night of hourly alerts in #error-pulse
(screenshot: prd breached every hour at ~540 DO-hours, dev/preview reported
"probe FAILED to run" twice). Implemented on this branch; a forced 🧪 TEST RUN from CI produced the daily thread in #error-pulse (headline + 2 threaded replies + in-place headline edit), read back through the Slack API. Merged in #2590; the 37 hourly alert messages from the prior 48h were deleted from #error-pulse by hand after merge.

## Why

The hourly probe (#2576) posts one top-level Slack message per breached
account per hour, so a chronic breach (prd's `project-worker` namespace,
~540 DO-hours/h ≈ $3/h since 2026-09-03 11:00) is 24 channel messages a day
saying the same thing. And after #2585 (slots erased after every run),
dev/preview legitimately has **zero** `durableObjectsPeriodicGroups` rows
overnight; the probe's "an empty series is never quiet" guard now fires as
"FAILED to run" every quiet hour.

## What changes

- [x] One headline message per UTC day in #error-pulse (`📒 Durable Objects
      — YYYY-MM-DD`), found via `conversations.history` or created on first
      run; every alert (breach, pinned invocation, probe failure) is a reply
      in that thread; the headline is rewritten on every run, breached or
      not, with today's picture per account: latest hour, hours over the
      ceiling today, today's total DO-hours and ≈$, probe failures.
      _(`renderDailyThread` + `findOrCreateHeadline` in scripts/ci/do-duration-alert.ts; a TEST RUN keeps its own thread)_
- [x] The probe reports every hour of the lookback in its summary (not only
      breached ones), and the alerter looks back 26h so "today" is complete.
- [x] Empty series: prove the credentials and account with a call that does
      not depend on activity (the DO namespace list), then treat no rows as
      0 DO-hours. Throw only when that proof fails.
- [x] Thresholds: dev/preview 1000 → 500 (~$2.80/h; healthy is 0–100 now, a
      relit slot is 2–4k); prd 400 → 600 (~$3.40/h; the pre-incident baseline
      is ~100, with `project-worker` ~540 — under it, so the chronic case is
      visible in the headline without an hourly reply).
- [x] Unit test for the headline/reply text from fixed summaries _(scripts/ci/do-duration-alert.test.ts)_

## Out of scope

- Fixing `project-worker/IterateContextDurableObject` itself (not in this
  repo; routed to its owner).
