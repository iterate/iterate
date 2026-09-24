# Context residency

A context is a Durable Object. On Cloudflare an idle one is evicted about 10 s after its last call,
and one that holds only hibernatable sockets hibernates. Anything that keeps it resident past that
is billed wall time for nothing: on 2026-09-22, ~125 parked Workers-RPC sessions held contexts
around the clock, 10.8M wall-seconds a day against 637 s of CPU.

Six mechanisms keep that from happening. Three release Workers-RPC sessions so a call leaves
nothing behind that holds an actor. Three are the context's own timers and resets for what it holds
on purpose or cannot stop others from holding.

| #   | Mechanism                              | Ends                                                       | Where                                                                               | Since                                |
| --- | -------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------ |
| 1   | `withItx` records every pipelined step | loaded and first-party code's hold on its context's values | `packages/iterate/src/sdk/record-pipelined-steps.ts`, lint `iterate/no-raw-itx-get` | #2846, removed #2855, restored #2863 |
| 2   | `itxAnswerDetachedFromSession`         | a caller's hold on what the context answered               | `src/context/dispatch.ts`, called by the DO's `invoke`                              | #2855                                |
| 3   | `awaitAnswerReleasedIfRejected`        | a rejected call's session                                  | `src/context/dispatch.ts`, called by the step walk                                  | #2874                                |
| 4   | The pins' release, 30 s                | borrowed rpc stubs, the library's open sockets             | [`src/context/residency.ts`](../src/context/residency.ts)                           | named in #2756                       |
| 5   | The birth reset                        | unclaimed loaded facets the last incarnation left running  | `residency.ts`, FacetHost `startFacetsTheLastIncarnationRan`                        | #2905                                |
| 6   | The quiet-period sweep, 60 s           | the same facets, while the context is still resident       | `residency.ts`, FacetHost `resetUnclaimedLoadedFacets`                              | #2905, clock fixed in #2922          |

Mechanisms 4–6 live in one class, `Residency` in [`src/context/residency.ts`](../src/context/residency.ts).
The context DO forwards its entry points to it and reads the sweep's deadline back for its one alarm
([`src/alarm-coordinator.ts`](../src/alarm-coordinator.ts)).

## What holds a context, and what ends it

| Something holds…                                                    | Example                                                                      | Ended by                                                                                 |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A live value the context answered with                              | a client keeps a `repos.get(path)` handle                                    | 2: the context answers with the expression that names the handle, never a live stub      |
| Data a hop below answered with                                      | a facet keeps `{ a: 1 }` a loaded worker returned through the context        | 2: the context answers with a copy and releases the original                             |
| A value the walk stepped past                                       | the `repos()` promise of `facet.repos().create(path)`                        | the walk's owner releases it once the answer is in (`releaseRpcSessions`, beside 3)      |
| A call that rejected                                                | a facet method threw; the promise keeps its session                          | 3: the walk releases the rejected answer                                                 |
| Values code got through `withItx` (all first-party code, templates) | `itx.cd(path)` in `itx.cd(path).append(…)`                                   | 1: `withItx` disposes every call it made, not only the last, and every handle it awaited |
| Values a loaded facet got from `env.ITX` directly                   | a project's own facet that calls `env.ITX.get()` itself and keeps the result | 5 and 6: an unclaimed loaded facet is reset                                              |
| A borrowed rpc stub, the library's socket                           | a subscribe callback, an `itx.connectToCapnweb(url)` WebSocket session       | 4: returned or closed 30 s after its last use                                            |

A facet needs 5 and 6 on top of 1 because the context cannot end a session from its side: the
facet holds the value. Both reset only a facet called since its last start (its `facet-ran:<name>`
row, written on its first call of an incarnation): one nobody called is not running. A loaded facet that keeps any value from its `env.ITX` keeps running after
its context is evicted, billed per instance, and the next incarnation reuses that same instance
(measured 2026-09-23: 19 minutes and counting, or until the next deploy). 5 and 6 are the net for a
project's own code; first-party code never relies on them. Every first-party facet, worker, config
template, example and `itx.run` script reaches its context through `withItx` (`this.withItx(fn)`
on an SDK host, `withItx(this.env.ITX, fn)` from `./processor.js` anywhere else, a `WithItx`
accessor for an object that needs reach), and lint refuses a raw `env.ITX.get()`
(`iterate/no-raw-itx-get`, embedded `"cap.js"` modules included) except in the rows that test this
net. First-party facets are never reset: they release every round trip through `withItx`, and the
`secret` facet pumps a proxied socket with no claim. A loaded facet that must outlive the call that started it (an LLM
attempt, its backoff, a live voice dial) holds a claim through `runInBackground`, and a claimed
facet is never reset.

## A reset is an abort and a start

On the edge, a facet that wrote a few dozen pages and then stops — aborted, or evicted with its
context — makes one of the context's next commits fail with "Internal error in Durable Object
storage caused object to be reset", and the whole context resets
([`e2e/facet-abort-storage-reset.e2e.test.ts`](../e2e/facet-abort-storage-reset.e2e.test.ts) measures
it). A facet started again before the context commits anything more avoids it. So every abort the
platform makes (5, 6, `itx.facets.abort`, the call watchdog, a new loaded identity) is followed by a
start under `blockConcurrencyWhile`, and a birth starts every facet the last incarnation called,
before its first write: the reset ones after their abort, a claimed or first-party one as it is.
FacetHost `FACET_START_WATCHDOG_MS` names every piece.

A birth that only an alarm caused needs the starts too. Its handler may write nothing, but the
runtime deletes the fired alarm once the handler returns, and that is a commit. #3100 skipped the
starts on the sweep's alarm-only wakes. On a preview, all 32 of those wakes whose facet had written
40 rows before the eviction failed their alarm invocation, and the runtime retried each one.

## After the last call

With nothing held, a context is evicted about 10 s after its last call and none of 4–6 does
anything. When something is held:

| After the last call                               | What happens                                                                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 30 s after the last pin use                       | 4: borrowed stubs returned, library sockets closed; the actor can hibernate                                                                |
| 60 s quiet from outside the project's loaded code | 6: if the context was evicted, the alarm wakes a fresh incarnation and its birth does the reset (5); if still resident, it resets in place |

## The sweep's quiet clock

The sweep's deadline is decided by one pure rule, `decideQuietDeadline`
([`src/context/residency.ts`](../src/context/residency.ts), table-tested beside it):

|                    | Sweep                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| Window             | 60 s (`UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS`)                                                                   |
| Armed by           | a loaded facet materialized, a claim released                                                                   |
| Clock restarted by | the end of an inbound call from outside the project's loaded code, a claim, an alarm pass that did durable work |
| When due           | resets the unclaimed loaded facets                                                                              |

Work in flight holds it off: inbound calls, facet calls, script runs and pin calls. A call from
loaded code (`caller.app`, a loaded worker's fetch) counts as work while in flight but does not
restart the clock. Otherwise a facet that calls its own context more often than the context would
evict would never be reset (#2922).

## Timers, alarms and incarnations

A pending `setTimeout` holds off eviction and hibernation for its whole length, billed; a durable
alarm holds off neither and still fires on time in a pinned incarnation (measured on a deployed
preview, 2026-09-23). So:

- The pins' release is a timer. It is armed only while a pin already holds the actor, and a pin
  lives and dies in memory with the actor, so a timer costs nothing extra.
- The sweep's deadline is a source of the context's one durable alarm. Its value lives in memory:
  a fresh incarnation has none, so an alarm an evicted incarnation left wakes it for nothing but
  its birth reset. These wakes write no wake record and no alarm trace.

## What to look for

| Signal                                                    | Written by                                                     |
| --------------------------------------------------------- | -------------------------------------------------------------- |
| `stream/woken` payload `facetsReset`                      | 5, on the incarnation's wake record                            |
| warn `facet.start-failed`, `facet.platform-failure-start` | a start after a reset or at birth that did not start the facet |
| log `context.facets-reset-at-birth`                       | 5                                                              |
| log `context.facets-reset-when-quiet`                     | 6                                                              |
| alarm trace `deadlines.unclaimedFacetSweep`               | the DO's alarm pass                                            |
| issue `itx-expression.release-rpc-session`                | 1–3, when a release throws                                     |

## Tests

- Unit: `src/context/residency.test.ts` (the sweep's rule and clock, the pins' timer, the birth
  reset's record);
  [`record-pipelined-steps.test.ts`](../../../packages/iterate/src/sdk/record-pipelined-steps.test.ts) (1);
  `src/context/dispatch.test.ts` (2).
- Lint: [`lint/oxlint-plugin-no-raw-itx-get.test.ts`](../../../lint/oxlint-plugin-no-raw-itx-get.test.ts)
  decides what `iterate/no-raw-itx-get` refuses, so no first-party code leans on 5 and 6.
- Workers suite: `__workers-tests__/alarm-and-pins.test.ts` (4),
  `__workers-tests__/facet-birth-reset.test.ts` (5, 6, and the sweep's alarm waking a fresh
  incarnation).
- Workers suite, the sweep's clock: `facet-birth-reset.test.ts` also decides that loaded code's
  calls never restart it and a project host's HTTP always does.
- Deployed: `e2e/context-residency.e2e.test.ts` reads wakes across idles for 1–3, 5 and 6, the
  resets a birth names on its wake record, and that a careless facet is no longer running once its
  quiet minute is up.
- Timed, opt-in: `perf/context-residency.perf.test.ts` (`RUN_RESIDENCY_TIMING=1`, or the soak's
  `residency-timing` input) measures what Cloudflare decides and the e2e rows only print: a facet
  the context no longer holds runs on past the context's eviction until the sweep, a context under
  5 s of project-host traffic keeps one instance, and a claimed attempt finishes on the instance
  that started it. Under the e2e run these sampled the platform: it stopped facets 0–25 s after
  their call and evicted a context mid-traffic while the control plane stalled (#2899, #2921,
  #2939). The latency guard never runs them.
- Deployed: `e2e/facet-abort-storage-reset.e2e.test.ts` pins the raw fault (a `createFailing` tagged
  `slow`), and, opt-in (`RUN_FACET_ABORT_REPRO=1`), drives every abort, and an eviction, with a
  storage-heavy facet.
