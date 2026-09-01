---
status: in-progress
size: large
---

# createFlake helper + flake telemetry

**Status summary:** Spec settled via a plannotator grilling session (7 revisions, all decisions below approved). Phase 1 (wrapper + recorder + sentinel) is the work in this PR; phases 2–3 (stream/dashboard, transition automation) are follow-ups.

A sibling to `failing` (see `packages/shared/src/test-support/failing-test.ts`) for tests that are *known flaky* with exactly one allowed error pattern:

```ts
import { createFlake } from "@iterate-com/shared/test-support/flake-test";

const flake = createFlake(test, /CPU startup time exceeded \d+ms/);

flake("Worker can be deployed", async () => {
  const deployment = await system.deploy();
  await expect.poll(() => fetch(deployment.url)).toMatchObject({ status: 200 });
});
```

## Settled decisions (grilled + approved 2026-09-01)

1. **API mirrors `failing`** — `createFlake(test, /pattern/)` returns a registrar preserving the wrapped runner's own types; works wherever `failing` works (vitest + playwright).
2. **Exactly one allowed failure pattern** — non-matching failures are real failures, never flakes. (Error-gated flake handling doesn't exist for vitest/playwright — rspec-retry/pytest-flaky have it; this is the novel bit.)
3. **Repo-global dashboard = evergreen GitHub issue** — get-or-create "Flake dashboard"; body renders a per-test table (flake rate over rolling window, last flake, trend, lane, links to recent failing runs).
4. **Always green except unexpected errors** — built on the runner's expected-fail machinery (`test.fails`/`test.fail`), like `failing`: matched error → rethrow (green); body passes → record + `throw new Error("Flaky test passed this run")` (green); non-matching error → swallow + return success → runner red. Same in-wrapper deadline race as `failing` so a hung body can't go vacuously green. Lifecycle is wrapper-switching, not red CI: flaky → `createFlake`, 0% pass → `failing`, 100% pass → normal test.
5. **No wrapper-level retry** — one unbiased sample per run; opt-in `repeat: N` later only if flake-rate estimates converge too slowly. Retry-until-pass would bias the one number the dashboard measures.
6. **Lifecycle transitions: automate the data-provable directions** — automation opens PRs to unwrap at sustained 100% and propose `failing` at sustained 0%; wrapping a plain flaky test stays human/agent-driven (choosing the pattern is a diagnosis).
7. **Transport = local JSONL recorder + CI post-step → iterate stream** — wrapper appends one line per outcome to a local file only when `FLAKE_RECORD_DIR` is set (no network/tokens in test workers). A CI post-step batches lines into one event per run+lane and appends via the itx API to a dedicated stream on prd. Fire-and-forget with a short timeout: unreachable prd gaps data, never reddens or slows CI.
8. **Dashboard processor = the single writer** — a stream processor folds per-test flake stats and owns the GitHub issue render as an obligation-pattern side effect (AI-linter pattern). Stream append is the serialization point; no git data branch, no aggregator workflow, no optimistic concurrency on the issue body. Transition automation later = processor side effects opening PRs via the GitHub capability.
9. **Transitions trust default-branch runs only** — all runs recorded + shown (branch-tagged); transitions gate on default-branch data, clean window resets on any edit to the test file. Starting thresholds (tunable): unwrap after 50 consecutive passes over ≥5 days; propose `failing` after 25 consecutive matched failures over ≥2 days.
10. **Helper location** — `packages/shared/src/test-support/flake-test.ts` beside `failing-test.ts`, sharing body-wrapping/toString/deadline machinery where sensible.
11. **Sentinel** — a deliberately ~10%-flaky test with a month-stamped error message (`hello I am September's monthly flake`), date-gated so it stops flaking when the month ends. Expected: dashboard shows ~10%; at month end the unwrap automation proposes removal — we don't merge, we roll the sentinel to the next month. Exercises detection, reporting, and transitions monthly.

Recorded outcome line fields (CTRF-ish names): test name, file, outcome (`pass` / `flake-fail` / `unexpected-error`), pattern source, duration, branch, commit, run id, lane.

## Phase 1 (this PR)

- [ ] `createFlake` in `packages/shared/src/test-support/flake-test.ts` — expected-fail registration, pattern gate, deadline race, recorder append
- [ ] Unit tests: matched failure → green; pass → green (+ recorded as pass); non-matching error → red; hang → red; recorder lines written only when `FLAKE_RECORD_DIR` set; fixture-parsing `toString` passthrough preserved
- [ ] Sentinel flake test using `createFlake` (month-stamped, ~10%)
- [ ] Docs: extend `docs/testing.md`'s "Flaky-test quarantine protocol" — flaky-but-runnable tests move to `createFlake` (keeps running, keeps reporting) instead of `test.skip`; the skip protocol remains for broken lanes and pathologically slow tests

## Phase 2 (follow-up PR)

- [ ] Flake event contract + dashboard stream processor (fold stats, render GitHub issue via obligation)
- [ ] CI post-step: batch recorder files → itx append (fire-and-forget, short timeout). Note: the always-running CI telemetry finalizer (`docs/ci-test-telemetry.md`) already collects per-test raw artifacts from every runner — the batching hook likely belongs there rather than a new workflow step. PostHog's `test_outcome` can't distinguish pass from flake-fail (both satisfy expected-fail), which is exactly what the recorder lines add.

## Phase 3 (follow-up PR)

- [ ] Transition automation: unwrap / propose-`failing` PRs as processor side effects

## Prior art (researched during grilling)

Trunk.io Flaky Tests, BuildPulse, [Datadog flaky management](https://docs.datadoghq.com/tests/flaky_management/) (grace-period un-quarantine), [Buildkite test states](https://buildkite.com/docs/pipelines/configure/tests/test-suites/test-state-and-quarantine) (enabled/muted/skipped — mute, never skip), [k8s flaky-tests](https://github.com/kubernetes/community/blob/main/contributors/devel/sig-testing/flaky-tests.md) (error-text clustering, zero-tolerance on blanket retries), [CTRF github-test-reporter](https://github.com/ctrf-io/github-test-reporter). In-house: the GitHub AI Linter starter app is the pattern for phases 2–3.
