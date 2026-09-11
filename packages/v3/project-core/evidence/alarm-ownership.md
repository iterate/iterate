# Processor alarm ownership — 5 September 2026

## Reproduction and cause

After fixing rejected RPC cleanup, the complete public suite still failed
31/32: `project-core-e2e-mtnklyvg-2f588fec400a` stopped at attempt 2 with
`retry_at=1788563640246`. An independent HTTP `inspect` at
`1788563745547` confirmed it was still overdue; this was not merely a slow
assertion. The synthetic state remains in `/tmp/project-core-rpc-cleanup-aDeWCG`.
The log is `wrangler-2026-09-04_23-13-24_288.log`.

The existing regression already exercises the real re-entry:

```ts
async processEvent(event) {
  const context = await this.env.ITX.get();
  await context.append({ id: "once/" + event.id, type: "once", data: {} });
  throw new Error("deliberate failure");
}
```

During an alarm invocation, workerd's
[`getAlarm()` returns null until another alarm is explicitly set](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/io/actor-cache.c%2B%2B#L678-L689).
The nested append tried to schedule processors while the current delivery was
still running. Its durable progress still contained the previous deadline,
`t1`, so it wrote `t1` again. After the throw, `fail()` recorded `t2`, but the
final arm saw the earlier stored alarm and declined to replace it. The consumed
old alarm could leave the new retry without a wake-up.

Temporary tagged instrumentation confirmed that sequence. For instrumented
project `project-core-e2e-mtnkp8vx-f0f97559d9e3`:

| Point                              | `current`     | `processorWake` | `now`         |
| ---------------------------------- | ------------- | --------------- | ------------- |
| Nested append, run active          | null          | 1788563791238   | 1788563791243 |
| Further nested arming              | 1788563791243 | 1788563791238   | 1788563791243 |
| Finishing run, new retry persisted | 1788563791243 | 1788563793245   | 1788563791245 |

`lendingWake` was null throughout. This instrumented run recovered via a
redundant old-alarm invocation; the earlier failed run did not. Logging changed
the race's outcome, not the demonstrated invalid scheduling sequence.

## Ownership correction

The active run owns its processor deadline. Normal nested calls can schedule
lending cleanup, but cannot re-arm stale processor progress:

```ts
async #armAlarm(processorWake = this.#processorRun ? null : this.processors.nextWake()) {
  // Combine this deadline with lending's deadline, then arm the earliest.
}

// Run finalizer, after delivery/progress changes, before releasing the single-flight guard:
await this.#armAlarm(this.processors.nextWake());
```

Scheduling during a run also sets a synchronous reschedule intent. The finalizer
clears the shared run and consumes that intent without another await, starting
one follow-up run if necessary. This covers an append arriving after the final
wake snapshot but before its storage write completes. It does not add another
failure retry policy: delivery still has three attempts with the existing
one-/two-second deadlines and durable terminal explanation.

`alarm()` still awaits its owned run and re-arm. Append does not await delivery,
so a processor can append to its own context without a dependency cycle.
No stale-alarm replacement fallback, extra polling timer, or increased timeout
was added. All `[DEBUG-core-alarm]` instrumentation was removed.

## Verification

The original four-project retry/halt case passed after the change. A new local
fixture at `/tmp/project-core-rpc-alarm-final-NKjLoE` then ran the full suite
alongside five additional repetitions of that case:

```sh
WORKER_BASE_URL=http://localhost:8799 \
  EGRESS_E2E_ADMIN_TOKEN=synthetic-egress-admin-token \
  pnpm --dir packages/v3/project-core test

for round in 1 2 3 4 5; do
  WORKER_BASE_URL=http://localhost:8799 pnpm --dir packages/v3/project-core exec \
    node --test --test-name-pattern='retries at least' e2e/processors.test.ts || exit 1
done
```

Full suite: 32/32, no skips, 10.41 seconds. Each additional run's four projects
reached terminal state and preserved the single idempotent derived event.
The fresh debug log `wrangler-2026-09-04_23-19-02_705.log` contains 75 deliberate
processor failures, three deliberate mounted-method exceptions, two expected
WebSocket peer closures, zero hung cancellations, zero `NOSENTRY` alarm
mismatches, and zero temporary diagnostic messages. This is local concurrent
re-entry proof, not deployed restart/eviction or throughput evidence.
