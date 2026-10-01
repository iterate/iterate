---
status: complete
size: small
---

# The "CI trace" commit status is a link, never a verdict

**Status:** done. `publish` posts `success` for every trace; tests and docs updated.

## Problem

The trace job (`.depot/workflows/preview-os.yml`, `.depot/workflows/main-os-e2e.yml`) posts a "CI
trace" commit status linking the run's trace in the ci-reports viewer. `scripts/ci/tracing/cli.ts`
`publish` sets its state from the run's verdict: `failure` when the trace has a time to red, `error`
when it has no verdict (cancelled). So one failing test shows as two red checks, e.g. on #3497 one
e2e row failed and the Auto-fix watcher reported both "Preview OS / E2E tests" and "CI trace".

The docs already say a status means the report exists and the run's own checks carry the verdict
(`docs/ci-traces.md`, `cli.ts` `publish` comment). "Playwright report" already follows that: always
`success`.

## Decision

"CI trace" always posts `success`. Its description keeps the verdict: "Time to green …", "Time to
red …", or "No verdict (…)".

Assumption: the cancelled case (`error` today) changes too. It is also red in GitHub's UI and has
the same problem: the trace exists, and the run's own checks already say it was cancelled.

## Checked: nothing reads the status's state

- The "Required CI" ruleset (18718115) requires lint-typecheck, Test, E2E tests and Browser specs.
- Main OS e2e's paging (`scripts/monitors/health.ts main-e2e`) judges Depot job results.
- `scripts/monitors/ttg.ts` reads Depot jobs, not GitHub statuses.
- `docs/pull-requests.md`'s `UNSTABLE` note names "Preview OS / CI trace", the trace job's check
  run, which still goes red when the job itself fails. Not this status.
- No code calls GitHub's status or check-run read APIs for it.

## Checklist

- [x] `cli.ts` `publish`: state `success` for every trace _`state: "success" as const`; the doc comment says why_
- [x] `cli.test.ts`: the three cases expect `success`, descriptions unchanged _the `test.for` table at the top_
- [x] `docs/ci-traces.md`: say the state is always success and the description carries the verdict _the two-status list at the top_

## Out of scope

- Moving reports from Depot artifacts (kept about a week) to the `iterate-ci` R2 bucket (90/365
  days). Separate change.
