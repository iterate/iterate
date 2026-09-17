---
status: in-progress
size: small
---
# Per-test Vitest CI traces

Status: investigation complete; implementation and validation pending. Reuse the CI trace report to expose Vitest test timings, with one span covering all retries of each test.

## Request and scope

Worktreeify the minimal tracing change investigated in Codex task `01a0b018-29cc-7ce3-a20f-2020dc4bc817`. App tests currently appear as one opaque CI step even though Vitest already records individual timings. Recent runs took about 138s, limited by long files/tests rather than runner CPU.

- [ ] Emit incremental start/end CI trace markers from the existing Vitest telemetry reporter, enabled only by `CI_TRACE_ENABLED=1`.
- [ ] Render each Vitest test with its runner timing, normalized outcome, source identity and aggregate retry count; retain incomplete starts after interruption and keep old Playwright traces working.
- [ ] Prove behavior using a real child Vitest run, including retries, expected failures, skips, failures and disabled tracing. Check interruption and test identity collisions through the trace assembler.
- [ ] Document timing/retry limits; run required checks and inspect the PR preview trace before completing the task.

## Decisions

- One span includes the test body, hooks and retries. No invented per-attempt timings.
- Reuse existing log storage, collector, viewer and OTLP JSON. No SDK or new service.
- No sharding, scheduling changes, test rewrites, nested phase instrumentation or deployed request tracing in this change.
- Public trace markers contain only identity, timing and outcome fields, never errors or raw test output.

## Implementation log

- Investigation checked two completed previews and a local Vitest 4.1.8 reporter probe. Test reporter callbacks fire once around all retries, and expected failures already have a normalized `passed` outcome.
