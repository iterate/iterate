# Streams

Durable, offset-ordered event streams — the platform's public coordination
primitive. One `StreamDurableObject` per (projectId, path) coordinate owns an
append-only journal in DO SQLite; everything else in the system observes or
extends a stream by appending events and processing them.

## The model

**Append is the commit point.** `append(...)` runs in one synchronous,
await-free turn: validate → assign offsets → reduce → persist. After the
persist line the append has succeeded; delivery, subscriber wakeups, and other
side effects are post-commit fan-out that cannot fail it. This synchronicity is
the whole reason stream storage methods are not `async` — see the warnings on
`append` in `stream-durable-object.ts`.

**State is a fold.** Every stream folds its own events into a reduced "core"
state (`maxOffset`, coordinates, pause door, configured subscriptions,
cross-post rules, live-subscriber presence roster). The `{state, version}`
checkpoint in DO KV is a disposable cache: version-skewed or missing state is
rebuilt by replaying the SQL event log.

**Processors subscribe; the core runs inline.** Domain logic lives in
`StreamProcessor` subclasses (agents, repos, secrets, itx, Slack, …) that are
fed batches through subscriptions. The stream's own core processor has the
same three-part shape as all of them —

|                    | hosted processor (`stream-processor.ts`)           | core processor (`stream-durable-object.ts`) |
| ------------------ | -------------------------------------------------- | ------------------------------------------- |
| contract / schemas | `*-processor-contract.ts`                          | `core-processor-contract.ts`                |
| pure fold          | `reduce`                                           | `#reduce`                                   |
| side effects       | `processEvent` / `processEventBatch`               | `#processEvent`                             |
| pre-commit gate    | — (impossible: subscriptions see committed events) | `#validateAppend`                           |

— but it runs inline in the append turn instead of behind a subscription,
which grants it the two powers no hosted processor can have: it is synchronous
with the commit, and `#validateAppend` can **reject an event before it becomes
a durable fact** (pause door, configured-subscriber target validation,
cross-post rule scoping).

## Subscriptions and connections

`stream-connections.ts` owns the live-delivery layer: the connection table,
the per-connection pump (catch-up replay from a cursor, then live batches),
RPC callback retention/disposal, and the idle teardown timer. The Stream DO
stays the policy owner — it decides who may subscribe, appends the presence
facts, and reconciles configured subscribers.

Two kinds of connection:

- **Ephemeral** (`subscribe`) — browsers, `waitForEvent`, operators. Dies with
  the caller; nothing re-establishes it.
- **Configured** (`subscribeConfigured`) — durable desired state, created by
  appending an `events.iterate.com/stream/subscription-configured` event. The
  stream re-wakes these subscribers forever: on DO wake, on config change, and
  on any append that finds a configured subscription without a live connection.

Presence is event-sourced: the stream appends `subscriber-connected` /
`subscriber-disconnected` facts once per actual open/close, and the core fold
mirrors them into a roster (`connectionsByKey`). A `stream/woken` fact clears
the roster — every connection died with the previous incarnation, and
survivors re-handshake — which keeps it truthful without heartbeats.

Both sides deliberately sever idle configured connections (in-memory timers,
never alarms) so quiet streams and their subscribers can hibernate instead of
pinning each other through cross-isolate RPC sessions. The durable subscription
config survives; the next append re-wakes.

## The wake handshake is a live-capability provide

Configured delivery is the same pattern as an itx live capability
(`domains/itx/live-capability.ts`):

1. The stream **wakes** the subscriber with serializable coordinates only
   (`wakeStreamSubscriber({ stream, subscriptionKey })` on the target DO or
   dynamic worker).
2. The subscriber answers `subscribeConfigured`, handing the stream a live
   `processEventBatch` **callback capability**.
3. The stream duplicates and retains that stub past the RPC call that
   delivered it, invokes it per committed batch, and disposes it on close —
   the same dup/dispose ownership rules as itx capability provision.

`stream-processor-host.ts` is the subscriber half: it maps a wake to a hosted
processor, opens the subscription from the processor's durable checkpoint
(`replayAfterOffset = checkpoint.offset`), and pumps batches into
`processor.ingest`. Its subtlety budget is spent on exactly one problem —
making the callback safe to re-issue: connection _generations_ fence off
batches from superseded connections, failed batches re-handshake from the
checkpoint (replay is idempotent), and a batch that fails
`MAX_CONSECUTIVE_INGEST_FAILURES` times is poison — the host records a
`stream/error-occurred` event and stays disconnected.

## Hosting processors in a Durable Object

```ts
export class RepoDurableObject extends DurableObject<Env> {
  readonly #host = createStreamProcessorHost(this.ctx, {
    stream: new StreamRpcTarget({ auth, projectId, path }),
  });
  readonly #repoProcessor = this.#host.add((deps) => new RepoProcessor({ ...deps, github }));

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest) {
    return this.#host.wakeStreamSubscriber(args);
  }
}
```

`add` registers the processor under its `contract.slug`, stores checkpoints in
DO KV, and gives the processor the host's own public `Stream` capability —
processors never hold raw DO stubs. The browser stream mirror
(`client-libraries/browser/`) is a second host of the same engine: it runs
real `StreamProcessor` subclasses against wa-sqlite with the same
announcements and checkpoints.

## File map

| File                         | Role                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `stream-durable-object.ts`   | The stream: append commit point, core processor (validate/reduce/processEvent), checkpoint, subscription policy |
| `core-processor-contract.ts` | Core contract: reduced-state schema + the `events.iterate.com/stream/*` event catalog                           |
| `stream-storage.ts`          | Chunked SQLite event log (2 MB cell limit → JS chunking)                                                        |
| `stream-connections.ts`      | Live connection table, delivery pump, RPC stub retention, idle teardown                                         |
| `stream-processor.ts`        | Processor contracts (`defineProcessorContract`) + the `StreamProcessor` base class                              |
| `stream-processor-host.ts`   | Hosts processors in a DO; subscriber half of the wake handshake                                                 |
| `schemas.ts`                 | `StreamEvent` / `StreamEventInput` zod schemas                                                                  |
| `utils.ts`                   | Stream path resolution + subscription-configured event builder                                                  |
| `client-libraries/`          | Browser mirror host and browser-side processors                                                                 |

Public capability surface (`Stream`, `StreamEventBatch`, `ProcessEventBatch`,
…) is defined in `src/types.ts`; the Cap'n Web / Workers RPC facades live in
`src/rpc-targets.ts`. Design doctrine: `docs/domain-objects-and-stream-processors.md`.
Debugging runbook: `apps/os/docs/debugging-streams.md`.
