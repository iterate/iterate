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

Artifact-first telemetry added by PR #2237 now records project creation,
whole-batch execution, client-observed completion spread, the configured remote
hold, and derived non-hold execution overhead. A no-retry run against
`preview_19` on 2026-07-21 took 53,858ms: 7,830ms project creation plus 46,020ms
execution. After subtracting the configured 30,000ms hold, the remaining
16,020ms was non-hold startup/fan-out/settlement overhead. Cross-isolate
`Date.now()` values are deliberately not compared: Cloudflare Workers clocks
are coarsened and may belong to different machines. Completion spread uses the
single Vitest process's monotonic clock instead.
The immediately preceding full-load preview sample took 84,500ms without these
new sub-phases, so the next full-load samples can measure how much contention
inflates that overhead.

## Work

- Use the recorded project, batch, client-completion-spread, hold, and non-hold-overhead
  phases to isolate full-load samples; correlate the remaining overhead with
  traces for bundle creation/cache lookup, dynamic Worker startup, and
  settlement.
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
