---
status: ready
size: small
---

# Failing e2e: an abandoned test project goes quiet

Worktree/branch/PR `abandoned-project-goes-quiet`, reproify style: a
`failing()` test that *should* pass and doesn't. No fix in this PR.

## The test, in one paragraph

Create a project with `createTestProject` (`apps/os/e2e/test-support/`),
point an agent at an `intercepted/*` model, run one turn, let it settle.
Record every stream's max offset. Dispose the fixture (today a no-op —
`create-test-project.ts:46`). Wait N seconds touching nothing. Read every
stream once. Assert nothing happened while we weren't looking.

## Design decisions (the two traps)

**1. Reads wake the thing you're measuring.** Any RPC into an asleep stream
boots it, and the boot appends `stream/woken` *before* serving the read. So
the final read manufactures one `woken` per stream by itself. Rule:
after the wait, read each stream exactly once, ordered by path; a stream is
"quiet" iff its only new events since the recorded offset are at most one
`stream/woken` whose `createdAt` ≥ the moment the final read pass began.
Anything else — a second `woken`, `heartbeat-triggered`,
`processor-revived`, `trigger-requested`, a delivery/facet fact — is a wake
we didn't cause, and the test names it in the failure message
(type, path, timestamp). *(Assumption to verify while writing: a boot's
`woken` is delivered to the project worker feed, not copied into sibling
streams. If it cascades, the ordering rule changes to leaves-first and the
tolerance becomes ≤1 woken per stream regardless of cause.)*

**2. The heartbeat is 15 minutes.** The template installs
`iterate/config/heartbeat/every-15-minutes`; a proper teardown must stop
it, so the test must be able to see it fire. Waiting 16 minutes is not a
test. Instead, after creation the test re-installs the heartbeat with a
fast recurrence — `itx.scheduler.set(...)` with `{ every: 5 }` seconds (the
template doc explicitly suggests `{ every: 1 }` for fast test projects).
Then N = 90s catches both flavors: the 10s stream loops and the heartbeat.
The scheduler stream (`/scheduler/primary`) is one of the streams read at
the end, so a surviving heartbeat shows up as `trigger-requested` events.

## Shape

- File: `apps/os/e2e/vitest/abandoned-project-goes-quiet.e2e.test.ts`.
  Same lane and connection helpers as `oversized-settlement-isolate.e2e.test.ts`.
- `const goesQuiet = failing(it, /woke .* times after dispose/)` from
  `@iterate-com/shared/test-support/failing-test`; the wrapper's deadline
  ≥ N + setup (~3 min). One test. Helpers at the bottom of the file.
- Streams enumerated via `project.streams.list()` at record time, so
  streams *created* after dispose (there shouldn't be any) also count as a
  failure.
- The failure message is the deliverable: a table of (path, event type,
  count, first/last timestamp) of everything that happened after dispose.
  That table is the evidence the write-up's why-2 is still missing.
- N configurable via env (`ABANDONED_PROJECT_QUIET_SECONDS`, default 90) so
  a longer soak can be run by hand.

## Not in scope

Fixing the disposer (the teardown task), the horizon, the ice switch,
reverting #2532. When teardown lands this test flips to passing and the
`failing()` wrapper is removed.

## Decided

Lives in the normal e2e lane (plan approved 2026-09-03): an expected-fail
that starts passing is exactly the signal CI should raise the day teardown
(or a revert) lands.

- [x] `apps/os/e2e/vitest/abandoned-project-goes-quiet.e2e.test.ts` as a
      `failing()` pin _(codemode reply shape from agent-fake-model-chat.spec.ts; ask waits for web-message-sent)_
- [x] Verified red-for-the-right-reason against preview_5 2026-09-03: 24
      heartbeat fires in the 90s window; no stream-loop wakes from a cleanly
      finished turn _(table in PR #2583)_
- [ ] Follow-up scenario: abandon a turn MID-flight (kill the interceptor
      before the reply) to pin the stream-loop flavor too
- [ ] Follow-up (blind spot): the test only sees appended events. An alarm
      firing into a *resident* DO and re-arming without appending is
      invisible to it (an evicted DO's fire boots it, which appends `woken`,
      so only the resident case hides). Close it at a product seam: have
      `StreamDurableObject.alarm()` (and the scheduler DO) bump a durable
      `{ alarmFires, lastAlarmAt }` in DO KV and surface it in
      `runtimeState()` — a read that plants no alarm — so the test can
      assert "no events AND no alarm fires" across the quiet window. Reads
      and pinned calls stay invisible, but those don't self-perpetuate.
