# Context residency

A context is a Durable Object. On Cloudflare an idle one is evicted about 10 s after its last call,
and one that holds only hibernatable sockets hibernates. Anything that keeps it resident past that
is billed wall time for nothing: on 2026-09-22, ~125 parked Workers-RPC sessions held contexts
around the clock, 10.8M wall-seconds a day against 637 s of CPU.

Seven mechanisms keep that from happening. Three release Workers-RPC sessions so a call leaves
nothing behind that holds an actor. Three are the context's own timers and resets for what it holds
on purpose or cannot stop others from holding. The last one records whatever the other six missed.

| #   | Mechanism                              | Ends                                                      | Where                                                             | Since                                |
| --- | -------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------ |
| 1   | `withItx` records every pipelined step | a facet's hold on its context's values                    | `packages/iterate/src/sdk/index.ts`, `record-pipelined-steps.ts`  | #2846, removed #2855, restored #2863 |
| 2   | `itxAnswerDetachedFromSession`         | a caller's hold on what the context answered              | `packages/iterate/src/expression.ts`, called by the DO's `invoke` | #2855                                |
| 3   | `awaitAnswerReleasedIfRejected`        | a rejected call's session                                 | `expression.ts`, called by the step walk                          | #2874                                |
| 4   | The pins' release, 30 s                | borrowed rpc stubs, the library's open sockets            | [`src/context/residency.ts`](../src/context/residency.ts)         | named in #2756                       |
| 5   | The birth reset                        | unclaimed loaded facets the last incarnation left running | `residency.ts`, FacetHost `resetUnclaimedLoadedFacets`            | #2905                                |
| 6   | The quiet-period sweep, 60 s           | the same facets, while the context is still resident      | `residency.ts`                                                    | #2905, clock fixed in #2922          |
| 7   | The residency watchdog, 15 min         | nothing: it records a held context                        | `residency.ts`, `src/context/residency-watchdog.ts`               | #2858                                |

Mechanisms 4–7 live in one class, `Residency` in [`src/context/residency.ts`](../src/context/residency.ts).
The context DO forwards its entry points to it and reads its two deadlines back for its one alarm
([`src/alarm-coordinator.ts`](../src/alarm-coordinator.ts)).

## What holds a context, and what ends it

| Something holds…                                                     | Example                                                                     | Ended by                                                                            |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| A live value the context answered with                               | a client keeps a `repos.get(path)` handle                                   | 2: the context answers with the expression that names the handle, never a live stub |
| Data a hop below answered with                                       | a facet keeps `{ a: 1 }` a loaded worker returned through the context       | 2: the context answers with a copy and releases the original                        |
| A value the walk stepped past                                        | the `repos()` promise of `facet.repos().create(path)`                       | the walk's owner releases it once the answer is in (`releaseRpcSessions`, beside 3) |
| A call that rejected                                                 | a facet method threw; the promise keeps its session                         | 3: the walk releases the rejected answer                                            |
| Values a facet got through `withItx` (first-party facets, SDK hosts) | `itx.cd(path)` in `itx.cd(path).append(…)`                                  | 1: `withItx` disposes every call it made, not only the last                         |
| Values a loaded facet got from `env.ITX` directly                    | a facet that calls `env.ITX.get()` itself and keeps the result              | 5 and 6: an unclaimed loaded facet is reset                                         |
| A borrowed rpc stub, the library's socket                            | a subscribe callback, an `itx.connectToCapnweb(url)` WebSocket session      | 4: returned or closed 30 s after its last use                                       |
| Anything else                                                        | a response body still streaming, a leaked session none of the above catches | 7: recorded after 15 quiet minutes, never ended                                     |

A facet needs 5 and 6 on top of 1 because the context cannot end a session from its side: the
facet holds the value. A loaded facet that keeps any value from its `env.ITX` keeps running after
its context is evicted, billed per instance, and the next incarnation reuses that same instance
(measured 2026-09-23: 19 minutes and counting, or until the next deploy). First-party facets are
never reset: they release every round trip through `withItx`, and the `secret` facet pumps a
proxied socket with no claim. A loaded facet that must outlive the call that started it (an LLM
attempt, its backoff, a live voice dial) holds a claim through `runInBackground`, and a claimed
facet is never reset.

## After the last call

With nothing held, a context is evicted about 10 s after its last call and none of 4–7 does
anything. When something is held:

| After the last call                               | What happens                                                                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 30 s after the last pin use                       | 4: borrowed stubs returned, library sockets closed; the actor can hibernate                                                                |
| 60 s quiet from outside the project's loaded code | 6: if the context was evicted, the alarm wakes a fresh incarnation and its birth does the reset (5); if still resident, it resets in place |
| 15 min with no inbound call and nothing in flight | 7: one `context.held-resident-while-idle` record, once per incarnation                                                                     |

## The two quiet clocks

The sweep and the watchdog share one pure rule, `decideQuietDeadline`
([`src/context/residency-watchdog.ts`](../src/context/residency-watchdog.ts), table-tested beside
it). Each has its own window and its own clock:

|                    | Watchdog                                 | Sweep                                                                                                           |
| ------------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Window             | 15 min (`RESIDENCY_WATCHDOG_WINDOW_MS`)  | 60 s (`UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS`)                                                                   |
| Armed by           | the first inbound call of an incarnation | a loaded facet materialized, a claim released                                                                   |
| Clock restarted by | the end of any inbound call              | the end of an inbound call from outside the project's loaded code, a claim, an alarm pass that did durable work |
| When due           | records the context as held              | resets the unclaimed loaded facets                                                                              |

Work in flight holds both off: inbound calls, facet calls, script runs and pin calls. A call from
loaded code (`caller.app`, a loaded worker's fetch) counts as work while in flight but does not
restart the sweep's clock. Otherwise a facet that calls its own context more often than the context
would evict would never be reset (#2922).

## Timers, alarms and incarnations

A pending `setTimeout` holds off eviction and hibernation for its whole length, billed; a durable
alarm holds off neither and still fires on time in a pinned incarnation (measured on a deployed
preview, 2026-09-23). So:

- The pins' release is a timer. It is armed only while a pin already holds the actor, and a pin
  lives and dies in memory with the actor, so a timer costs nothing extra.
- The sweep's and the watchdog's deadlines are sources of the context's one durable alarm. Their
  values live in memory: a fresh incarnation has none, so an alarm an evicted incarnation left
  wakes it for nothing but its birth reset. These wakes write no wake record and no alarm trace.

## What to look for

| Signal                                                                                               | Written by                                                     |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `stream/woken` payload `facetsReset`                                                                 | 5, on the incarnation's wake record                            |
| log `context.facets-reset-at-birth`                                                                  | 5                                                              |
| log `context.facets-reset-when-quiet`                                                                | 6                                                              |
| warn `context.held-resident-while-idle`, event `events.iterate.com/context/held-resident-while-idle` | 7; `durableObjectId` finds the held invocation in Workers Logs |
| alarm trace `deadlines.residencyWatchdog`, `deadlines.unclaimedFacetSweep`                           | the DO's alarm pass                                            |
| issue `itx-expression.release-rpc-session`                                                           | 1–3, when a release throws                                     |

Nothing pages on the watchdog's warn: [`scripts/ci/prd-fault-alarm.ts`](../../../scripts/ci/prd-fault-alarm.ts)
pages on 5xx, platform-failure heals and errors.

## Tests

- Unit: `src/context/residency.test.ts` (the clocks, the pins' timer, the record) and
  `src/context/residency-watchdog.test.ts` (the shared rule);
  [`record-pipelined-steps.test.ts`](../../../packages/iterate/src/sdk/record-pipelined-steps.test.ts) (1);
  `src/context/expression.test.ts` (2).
- Workers suite: `__workers-tests__/alarm-and-pins.test.ts` (4),
  `__workers-tests__/facet-birth-reset.test.ts` (5, 6),
  `__workers-tests__/residency-watchdog.test.ts` and `context-abort-and-the-watchdog.test.ts` (7).
- Workers lane, the sweep's clock: `facet-birth-reset.test.ts` also decides that loaded code's
  calls never restart it and a project host's HTTP always does.
- Deployed: `e2e/context-residency.e2e.test.ts` reads wakes across idles for 1–3, 5 and 6, the
  resets a birth names on its wake record, and that a careless facet is no longer running once its
  quiet minute is up; `e2e/context-watchdog.e2e.test.ts` waits out a real watchdog window.
- Timed, in the soak: `perf/context-residency.perf.test.ts` measures what Cloudflare decides and
  the e2e rows cannot assert: a facet the context no longer holds runs on past the context's
  eviction until the sweep, a context under 5 s of project-host traffic keeps one instance, and a
  claimed attempt finishes on the instance that started it. Under the e2e run these sampled the
  platform: it stopped facets 0–25 s after their call and evicted a context mid-traffic while the
  control plane stalled (#2899, #2921, #2939).
