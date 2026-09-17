---
status: complete
size: small
---
# Per-test Vitest CI traces

Status: complete in [PR #2722](https://github.com/iterate/iterate/pull/2722). Local checks and CI pass; the hosted preview trace contains all 416 executed Vitest tests alongside 92 Playwright attempts. No outstanding review threads.

## Request and scope

Worktreeify the minimal tracing change investigated in Codex task `01a0b018-29cc-7ce3-a20f-2020dc4bc817`. App tests currently appear as one opaque CI step even though Vitest already records individual timings. Recent runs took about 138s, limited by long files/tests rather than runner CPU.

- [x] Emit incremental start/end CI trace markers from the existing Vitest telemetry reporter, enabled only by `CI_TRACE_ENABLED=1`. *Added callbacks to the existing shared retry telemetry reporter.*
- [x] Render each Vitest test with its runner timing, normalized outcome, source identity and aggregate retry count; retain incomplete starts after interruption and keep old Playwright traces working. *Assembler distinguishes Vitest aggregates; viewer counts retries without claiming separate attempts.*
- [x] Prove behavior using a real child Vitest run, including retries, expected failures, skips, failures and disabled tracing. Check interruption through the trace assembler; namespace test IDs by reporter artifact to keep parallel app runs distinct. *Real-run coverage in `scripts/ci/tracing/vitest.test.ts`; 28 focused tracing tests pass.*
- [x] Document timing/retry limits; run required checks and inspect the PR preview trace before completing the task. *Updated `docs/ci-traces.md`; full local checks and preview pass; inspected the hosted report in isolated headless Playwriter.*

## Decisions

- One span includes the test body, hooks and retries. No invented per-attempt timings.
- Reuse existing log storage, collector, viewer and OTLP JSON. No SDK or new service.
- No sharding, scheduling changes, test rewrites, nested phase instrumentation or deployed request tracing in this change.
- Public trace markers contain only identity, timing and outcome fields, never errors or raw test output.

## Implementation log

- Investigation checked two completed previews and a local Vitest 4.1.8 reporter probe. Test reporter callbacks fire once around all retries, and expected failures already have a normalized `passed` outcome.

- First real-run integration spec failed with no trace markers; after implementing reporter callbacks and assembler support it passed alongside all 26 existing tracing tests.

- Full typecheck caught nominal Vitest class incompatibility between workspaces; retained the reporter’s structural type boundary. The first full test run overloaded nested child runs, so interruption assertions now reuse the real-run fixture instead of launching redundant runners.

- Local install, typecheck, lint, knip, format and full test suite passed. CI’s tracked-file skip guard then correctly required classifying the deliberately skipped child-runner fixture; added an explicit structural-fixture allowlist entry rather than disguising the skip.

- Preview `9mcrl0tmgq` at `548351152c7d` passed App tests, all six Playwright shards and cleanup. Compared all 416 executed Vitest tests across six workspaces against raw telemetry: unique markers, matching outcomes, retry counts and durations. The hosted JSON exactly matches local collection; 92 Playwright spans remain present.

- [Live trace](https://depot-01a0b02c-60d3-76e4-b555-6f8ba4a2ded1--iterate.iterate.app/): browser inspection verified filtering, selection, zoom and Vitest evidence. No page errors; one existing hosted-iframe sandbox warning. Screenshot is attached to the PR. The longest Vitest test took 103s inside a 134s App tests phase; this change exposes that timing without changing execution.

- No submitted reviews or outstanding threads at completion. Registered with the global PR monitor through 2026-09-18T16:07:54Z for later feedback.
