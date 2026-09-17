---
status: in-progress
size: small
---
# Per-test Vitest CI traces

Status: reporter and trace rendering implemented; focused integration checks pass. Required repository checks and live preview evidence remain.

## Request and scope

Worktreeify the minimal tracing change investigated in Codex task `01a0b018-29cc-7ce3-a20f-2020dc4bc817`. App tests currently appear as one opaque CI step even though Vitest already records individual timings. Recent runs took about 138s, limited by long files/tests rather than runner CPU.

- [x] Emit incremental start/end CI trace markers from the existing Vitest telemetry reporter, enabled only by `CI_TRACE_ENABLED=1`. *Added callbacks to the existing shared retry telemetry reporter.*
- [x] Render each Vitest test with its runner timing, normalized outcome, source identity and aggregate retry count; retain incomplete starts after interruption and keep old Playwright traces working. *Assembler distinguishes Vitest aggregates; viewer counts retries without claiming separate attempts.*
- [ ] Prove behavior using a real child Vitest run, including retries, expected failures, skips, failures and disabled tracing. Check interruption through the trace assembler; namespace test IDs by reporter artifact to keep parallel app runs distinct.
- [ ] Document timing/retry limits; run required checks and inspect the PR preview trace before completing the task.

## Decisions

- One span includes the test body, hooks and retries. No invented per-attempt timings.
- Reuse existing log storage, collector, viewer and OTLP JSON. No SDK or new service.
- No sharding, scheduling changes, test rewrites, nested phase instrumentation or deployed request tracing in this change.
- Public trace markers contain only identity, timing and outcome fields, never errors or raw test output.

## Implementation log

- Investigation checked two completed previews and a local Vitest 4.1.8 reporter probe. Test reporter callbacks fire once around all retries, and expected failures already have a normalized `passed` outcome.

- First real-run integration spec failed with no trace markers; after implementing reporter callbacks and assembler support it passed alongside all 26 existing tracing tests.

- Full typecheck caught nominal Vitest class incompatibility between workspaces; retained the reporter’s structural type boundary. The first full test run overloaded nested child runs, so interruption assertions now reuse the real-run fixture instead of launching redundant runners.
