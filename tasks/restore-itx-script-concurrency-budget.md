---
state: todo
priority: high
size: small
tags: [os, e2e, ci, performance, itx]
---

# Restore the ITX script concurrency budget to 50 seconds

The deployed-worker regression test `concurrent long-running itx scripts all
complete` holds 20 scripts for 30 seconds and historically required the whole
batch to finish in under 50 seconds. PR #2169 temporarily raises that
completion budget to 80 seconds (and the Vitest watchdog to 120 seconds) so a
cold worker-bundler path under the fully parallel preview load does not block
unrelated pull requests.

## Evidence

At commit `f55da2598ee852eea3978997ef307df07151273e`, the preview run completed
all 20 scripts successfully in 69,476ms on the first attempt, exceeding only
the 50-second performance assertion. Its permitted retry passed. This is a
latency regression, not a functional script-execution failure, and retry
telemetry remains visible in the preview report.

## Work

- Record phase timings for project creation, bundle creation/cache lookup,
  dynamic Worker startup, the deliberate 30-second hold, and settlement.
- Reproduce both cold and warm runs under the normal fully parallel preview
  load and determine why the first attempt adds roughly 39 seconds.
- Remove avoidable cold-path or contention latency without reducing the 20
  concurrent scripts or their 30-second hold.
- Restore `MAX_CONCURRENT_COMPLETION_MS` to 50,000 and the per-test watchdog to
  90,000.

## Exit criteria

- The original 50-second assertion passes on the first attempt for at least 20
  consecutive full-load preview runs.
- Trace evidence shows all 20 executions overlap as intended and leaves no
  unexplained errors, stalled work, or leaked dynamic Workers.
