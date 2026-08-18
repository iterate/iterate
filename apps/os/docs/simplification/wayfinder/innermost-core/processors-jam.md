# Processors jam v5 — grounded in apps/os, simplified where the ground allows

v5 after seven annotations on v4, two of which were an instruction: _ground this in what
apps/os has today and find a simpler model that is equally expressive_, and _ephemeral events
are a must_. Two mapping passes over apps/os back everything below (`stream-event-sender.ts`
2485 lines, `stream-durable-object.ts`, the runner, the ephemeral buffer, and the three
delivery-latency commits on `stream-for-audio`). Where v4 guessed, v5 cites.

The headline: **your annotation-5 instinct — "just call `processEventBatch` on the facet; wake
is the thing that makes a far-away subscriber connect" — is almost verbatim the apps/os
hosted-connection model.** The stream dials a cold processor once; the processor hands back
`{checkpointOffset, processEventBatch}` (a callback stub); pushes then flow over that live
connection, results returning on a separate one-shot callback (awaiting the push return can
deadlock two DOs). v5 adopts that shape and deletes v4's facet-nudge framing.

## What apps/os actually has (the ground)

**Five receiver kinds** (`SubscriptionReceiver`, core-processor-contract.ts):

| kind              | cursor owner                                                          | delivery                                                      |
| ----------------- | --------------------------------------------------------------------- | ------------------------------------------------------------- |
| `facet-processor` | consumer (runner's own KV, CAS-fenced)                                | stream dials facet in-process; pushed batches over a callback |
| `wake-processor`  | consumer                                                              | same, but the dial is an itx expression                       |
| `itx-call`        | **stream** (SQLite cursor row; the awaited call resolving IS the ack) | one batch in flight, loop until caught up                     |
| `webhook-post`    | **stream**                                                            | HTTP POST, batch size 1                                       |
| `copy-to-stream`  | **stream**                                                            | append into another stream                                    |

- **Configuration is event-sourced into the fold; cursor rows are projections, not truth**
  (rows whose name left the fold are deleted on every pass). Exactly v4's rows-as-events +
  derived-index shape — already proven there.
- **Live sessions/browsers are NOT rows.** In-memory connections only; "they own no durable
  cursor, so a hole costs them nothing"; the client replays after ITS OWN offset then goes
  live. (Annotation 3 answered: apps/os agrees with you — the server does not track what a
  browser has seen.)
- **The commit path never awaits delivery.** Append → SQLite insert → synchronous `sendDue`;
  real sends ride an alarm boundary (outside an alarm turn, `setAlarm(now)` and return) to
  break the append↔delivery↔caller cycle.
- **No dead-letter queue exists.** The real ladder: backoff retries (1s·2^n, cap 30min, ±20%
  jitter, 15 attempts ≈ 2h), poison-event isolation (`onFailingEvent: "skip"`: 3 isolated
  failures → skip + audit event), then **halt** — event-sourced, resumable
  (`resumeSubscription`, `setSubscriptionCursor`). Simpler than a DLQ and fully auditable.
- **The stateless worker is not a special mechanism** — it is an ordinary `itx-call` push
  subscription named `project-worker` targeting `["processEventBatch"]`, `onFailingEvent:
"skip"`. The author subclasses the SDK entrypoint and writes `processEvent(event)`; throwing
  redelivers; the stream owns offset/retry machinery. (Your "must-support" case: confirmed, and
  it is one row, not a subsystem.)
- **Stub disposal** (the "super important to retain" code): every fire-and-forget push runs
  `disposeIgnoredRpcResult(result)` — an unused RPC return is still a disposable stub and leaks
  the remote reference otherwise; apps/os repeats the discipline at eight early-exit points on
  the wake path.

**Ephemeral events** (the must-have, as shipped):

- An envelope field: `ephemeral: true` (with `idempotencyKey` rejected — nothing idempotent
  about the unreplayable). Bodies live in a 10 MiB FIFO memory buffer; **the whole buffer dies
  with the incarnation, by design** ("an ephemeral event's body cannot be redelivered by
  anyone").
- **One shared offset sequence.** Ephemerals consume offsets; after reboot their offsets remain
  as _valid gaps_. Consumers advance on **scan-window proof** (`scannedAfterOffset` /
  `scannedThroughOffset`), not by counting events — that one mechanism makes ephemeral holes,
  filters, and reboot gaps all the same non-event.
- **Almost zero writes — deliberately not zero:** a pure-ephemeral append performs exactly one
  tiny SQLite write, the `stream_metadata` highest-assigned-offset update, because that is the
  only thing preventing offset REUSE after the incarnation dies (a reused offset with a
  different body hard-aborts browser stores). Everything else about the append is memory.
- **Who sees them:** live sessions always; processors only by NAMING the type in `consumes`
  (`"*"` never sweeps ephemerals); stream-cursor push kinds never (their cursor still
  advances). Folds MAY reduce them, and a rebuild silently omits them — the written rule is
  "never derive durable product truth from an ephemeral event" (chunks fold into live UI state;
  the settled durable fact carries the full text).
- **The delivery-latency trilogy** (the 2026-08-17 fixes, our design-ins rather than
  retrofits): (1) all-ephemeral batches ride **uninsured** — no in-flight SQLite writes, no
  alarm write; liveness comes from a wedge-check in the send loop instead; (2) **coalesce** —
  batch limit is a function, not `=1`; 225 batches for 194 events was the smoking gun; (3)
  **pipeline** uninsured batches back-to-back, bounded at 4 in flight. Recorded effect: uplink
  lateness p90 188ms → 38ms; ~700ms shaved off a ~1900ms press-to-answer.
- **Durability modulation that exists:** fold checkpoint debounced (every 64 events or 1s —
  event rows are truth, boot folds past a stale checkpoint); runner commits once per delivered
  batch (the deliberate at-least-once replay window); alarm writes deduped (`armNoLaterThan`).
  Known cost hole pre-fix: hosted delivery spent ~2 SQLite writes + an alarm write per event.

## The clean-room model (simpler, same expressiveness)

**Two subscription modes, not five kinds.** The three stream-cursor kinds differ only in what
they call — which is exactly what an itx expression says. So:

| mode          | cursor                            | the row                                                          |
| ------------- | --------------------------------- | ---------------------------------------------------------------- |
| **processor** | consumer-held                     | `{name, target: <expr resolving to the processor>, consumes}`    |
| **push**      | stream-held (+ retries/skip/halt) | `{name, target: <any itx expression>, consumes, onFailingEvent}` |

`webhook-post` = a push row whose target is an egress fetch expression. `copy-to-stream` = a
push row targeting `itx.streams.get('/other').append(...?)`. `itx-call` = the general case.
The stateless `processEvent` worker = a push row targeting the project worker. One retry/skip/
halt ladder serves them all (no dead-letter — apps/os proves halt+skip+audit suffices). The
jsonata transform does not come over; a transform is a real function in the config worker.

**Delivery, one mechanism (annotations 5+6 resolved):**

- **THE PUMP lives in the stream** — the only sender. After a commit it pushes
  `processEventBatch(batch, window)` to every current connection, in order, fire-and-forget,
  disposing each push's returned stub. There is no separate per-subscriber "catch-up loop"
  competing with it — what v4 called that is only **gap repair**: a subscriber that boots (or
  sees a non-contiguous window) reads once from its own cursor, then rides pushes again.
- **A facet IS a connection that never dials.** The parent pushes `processEventBatch` straight
  into the facet on every commit — the call itself loads the durable object; no nudge concept,
  no wake for facets, ever. Contiguity rides the same scan-window proof.
- **`wake` is only for the far away** — the cold-start verb of the connection model: the
  stream evaluates the row's target expression once, the remote durable object answers with
  `{checkpointOffset, processEventBatch}` (your words: "in the callback it passes across the
  RPC boundary, it can call its own this.processEventBatch" — that is literally the shipped
  design), and pushes flow until the connection dies; every re-wake replays from the
  subscriber's own checkpoint. Watchdog + rpc-broken detection bound the loss.
- **Browsers:** live connections, no rows, no server-held cursor; the client says "everything
  after 75" on reconnect. (Server-held per-tab cursors: rejected — apps/os agrees.)

**Ephemeral events, clean-room requirements (annotation 1):**

- Envelope `ephemeral: true`; memory ring with byte cap; shared offset sequence; scan-window
  delivery. Adopt the ONE deliberate write (highest-assigned-offset) with its rationale stated
  — or accept offset-reuse-after-reboot and delete even that; recommend adopting it, it is one
  tiny UPDATE per append _batch_, and offset reuse is a data-corruption class.
- **Zero fold/cursor writes on ephemeral-only activity**: uninsured push batches, coalescing,
  bounded pipelining from day one (the trilogy as design, not retrofit); fold checkpoints
  debounced and NEVER triggered by ephemeral-only deltas; processor progress commits only when
  a window containing durable events completes.
- Reduce may fold ephemerals; rebuilds omit them; the divergence rule is stated in the SDK
  docs ("never derive durable truth from an ephemeral event") and the runner makes the
  eventless rebuild-vs-live difference visible in `getRuntimeState`… which no longer exists —
  so: visible in `snapshot()`'s offset honesty (it reports the durable fold offset).

**Expression-valued arguments are strings (annotation 7):** no grammar change.
`itx.workers.get({ type: 'stateful', source: "itx.files.read('/heavy.js')", className:
'Heavy' })` — the receiving root parses the string as an expression (it already accepts either
codec half). v4's call-by-value idea dies: the receiver _wants the name_, not the value.

## Still standing (decided)

- The collapse: registry → SDK base class (TypeScript, prebuilt); authors write
  `reduce`/`processEvent`; read surface = `snapshot()` + `waitUntilProcessed` (kept: in
  apps/os it is ONE uniform verb split by kind — processor kinds relay to the runner's
  barrier, push kinds park a waiter on the row's confirmed cursor; same split here).
- Facets host durable objects; the facet address (`facetInvoke` + the native fetch/101 door);
  `enableProcessor` dissolves into `subscribe`.
- `roots` naming still open (behavior settled); ITX-vs-STREAM identity still open.

## Increment plan v5

1. **Collapse + SDK** (unchanged scope, minus every `deliver`/nudge naming).
2. **The pump + processor mode:** push `processEventBatch(batch, window)` into facets
   per commit; scan-window contiguity; gap repair on boot; ephemeral envelope + memory ring +
   the one metadata write; live proof: a voice-shaped ephemeral flood folds into a facet with
   ZERO fold/cursor writes and byte-identical durable refold.
3. **Push mode:** stream-held cursor rows + retry/skip/halt ladder; the stateless
   `processEvent` worker proof; per-push disposal.
4. **The facet address** (as before).
5. **Deferred:** remote wake connections (the shape is fully specified above; built when a
   remote processor exists).

## Open questions v5

1. Go on increments 1–4?
2. The one deliberate metadata write on ephemeral appends: adopt (recommended) or pursue true
   zero-write with offset-reuse risk?
3. Ephemeral opt-in for processors: apps/os requires NAMING the type in `consumes` (`"*"`
   never sweeps ephemerals). Keep that rule verbatim?
4. `waitUntilProcessed` kept as the one barrier verb (split by mode, as apps/os) — confirm?
