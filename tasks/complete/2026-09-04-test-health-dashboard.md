---
status: done
size: medium
branch: test-health-dashboard
---

# Test health dashboard: failing pins, sections, unknown flakes

Agreed in discussion 2026-09-04. One PR (Misha: "do one PR so there's not so
much to keep track of"). The flake dashboard becomes a general test-health
dashboard with grouped sections and — the headline — an adoption funnel for
flakes nobody has classified yet.

## Status

Implemented. All checklist items done; 26/26 dashboard harness tests, 44+2
shared tests, typecheck/lint/knip clean. Awaiting CI + review.

## Design

**Record shape** (shared FlakeRecord + dashboard contract, back-compatible —
old events must still parse for refolds):

- `kind: "flake" | "failing" | "unknown"` (absent in old records → "flake")
- ~~`sentinel?: boolean` createFlake option~~ _(Misha: prefer matching the name — sentinels are identified by "flake sentinel" in the test name; no wire-format field, works for all historical records)_
- `pattern` becomes optional (unknown records have none)
- outcome grows: `pinned-fail`, `unexpected-pass` (createFailing),
  `retried-pass` (unknown)

**createFailing records** (additive edits only — PR #2575 also touches this
file): pinned-fail (pin held, green), unexpected-pass (bug looks fixed),
unexpected-error (proves nothing).

**Unknown flakes**: no new reporters — the existing telemetry reporters
already see every retried test. A shared pure helper
`unknownFlakeRecordFromTelemetry(record)` maps a telemetry test record with
`passedAfterRetry && expectedState === "passed"` to a
`kind: "unknown", outcome: "retried-pass"` flake record carrying
`firstFailure` as the error sample; RetryTelemetryReporter (vitest) and
PlaywrightTelemetryReporter (scripts/ci) both call it and append via the
shared `appendFlakeRecord`. `expectedState === "passed"` excludes
createFlake/createFailing registrations (fails-mode), so kinds never mix.
Tests that fail all retries are just red CI — not recorded.

**Dashboard** (contract 0.4.0 → 0.5.0, refold rebuilds everything):

- Sections in order: `## Flakes`, `## Failures`, `## Sentinels`,
  `## Unknown flakes` — same 4 columns, only non-empty sections render.
- Per-section emoji semantics (honest colors): Failures show 🟥 = pin held
  (the bug is present), 🟩 = unexpected pass; Unknown rows are 🟥-only
  (only flake events are recorded, there is no pass denominator).
- Unknown rows: info cell shows the last few error samples (truncated,
  pipe-escaped) — the copy-paste material for the createFlake regex; stats
  show flake count + last flake, no rate.
- Failures stats: runs, pin-held / unexpected-pass counts, `pinned since`
  (new `firstRecordedAt` in state).
- counts generalize to a per-outcome record (keys are outcome strings).
- Streak machinery generalizes to any outcome; unexpected-error still resets.
- Expiry: flake/failing/sentinel keep the 3-run window; unknown rows expire
  by time instead (no flake recorded in 14 days) since they are absent from
  most runs by nature. renderBody takes an explicit `nowMs`.
- Transitions: sentinels are excluded from proposals (the flag finally lets
  us); new `unwrap-failing` transition when a pin's unexpected-pass streak
  crosses a threshold (10 runs / 2 days). Known gap unchanged: streaks are
  default-branch-only, so PR-only suites still never propose.
- Issue title stays "Flake dashboard" (title lives in the immutable birth
  certificate; retitling is a separate config-evolution problem).

## Checklist

- [x] Extract `flake-record.ts` (FlakeRecord type + appendFlakeRecord +
      unknownFlakeRecordFromTelemetry) in shared test-support; add package
      export. _(No re-export needed — nothing outside shared imported the type.)_
- [x] ~~createFlake `sentinel` option~~ Sentinels detected by name instead
      (`isSentinel` in worker.ts matches "flake sentinel"); the three
      sentinel files stay untouched.
- [x] createFailing writes records (kind failing, three outcomes).
- [x] Wire unknownFlakeRecordFromTelemetry into RetryTelemetryReporter and
      PlaywrightTelemetryReporter.
- [x] Dashboard contract + reduce + render per design; version 0.5.0.
- [x] Tests: dashboard harness (sections, unknown expiry by time, sentinel
      proposal exclusion, unwrap-failing proposal, error samples render);
      shared (failing records, sentinel passthrough,
      unknownFlakeRecordFromTelemetry cases).
- [x] docs/testing.md: short paragraph on unknown-flake records and the
      adoption funnel.

## Notes

- Found while previewing against the PR's own CI artifacts: several unit
  tests executed wrapper bodies (and the vitest reporter) under CI's real
  FLAKE_RECORD_DIR, leaking synthetic records (`name`, the failing-test live
  registration, the reporter fixture's `network > reconnects`). Fixed by
  scoping FLAKE_RECORD_DIR in every body-executing test, moving the live
  registration into the child-process fixture, and stripping the env in the
  playwright reporter test. The fixture also re-proved #2575's finding —
  createFailing needed the vitest `retry: 0` pin (added here minimally;
  #2575's fuller version supersedes on merge).

- Conflict heads-up: #2575 (still open) edits failing-test.ts; keep this
  branch's edits there additive (imports + record calls inside the existing
  outcome branches).
- Suites contributing unknown flakes: every retried lane (os/auth/semaphore/
  mobile e2e vitest configs, root playwright specs). Unretried unit suites
  contribute nothing — acceptable.
