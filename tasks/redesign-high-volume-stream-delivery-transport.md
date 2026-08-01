---
state: backlog
priority: high
size: large
dependsOn: []
---

# Choose a durable transport for sustained high-volume stream delivery

## Problem

Our live stream API currently delivers events through reverse Cap'n Web
callbacks. A client opens one physical WebSocket to the OS Worker's `/api`
route, and Cap'n Web multiplexes the session, project and stream capabilities,
and logical `stream.openConnection()` callbacks over that socket. The Worker
`fetch` invocation that accepted the physical socket remains the outer
invocation for its lifetime.

Cloudflare charges the Durable Object and Workers RPC subrequests behind
callback delivery to that outer invocation. The paid-plan default is 10,000
subrequests per invocation. Opening a new logical stream callback on the same
Cap'n Web socket does not create a new Worker invocation and therefore does not
reset the budget.

This failed silently in a deployed preview during the realtime-audio work:

- a controlled subscriber held one physical `/api` WebSocket while 12,000
  events were appended at 120 events/s;
- delivery stopped at exactly 10,000 events;
- appends continued to succeed;
- the WebSocket stayed open and responsive;
- no close or callback error reached the consumer; and
- replacing the logical callback on the same socket did not recover, while a
  new physical socket did.

The original audio-shaped path stopped after roughly 1,000–1,300 pushed
batches, about 25 seconds at 50 events/s, because one callback batch can spend
multiple subrequests across the actual RPC/DO topology. Application event or
batch count is not the Cloudflare budget counter.

Do not assume this explains every older stream-stall report. In particular,
[`stream-subscriber-deliveries-stall-mid-turn.md`](./stream-subscriber-deliveries-stall-mid-turn.md)
predates this repro and includes stream-incarnation/reset evidence that may be
a separate defect.

## Immediate mitigation

PR #2378 sets `limits.subrequests: 10_000_000`, Cloudflare's finite platform
maximum, in the generated OS Wrangler config. That one inheritable setting is
used by local dev and every `preview_N` and `prd` OS deployment; compiler
sidecars do not receive it.

This raises the previous default by 1,000× and buys time for an architectural
decision. It does not make an unbounded callback safe, turn silent exhaustion
into an error, or define the right long-term streaming abstraction.

## Decide whether reverse callbacks are the right abstraction

The central question is whether a long-lived event stream should be modelled
as repeated calls into a retained reverse RPC capability at all. The model is
convenient and capability-safe, but it couples sustained data delivery to the
lifetime and subrequest accounting of an outer stateless Worker invocation.

The chosen design must cover both:

1. interactive consumers such as browsers, Node/TUI clients, audio, and
   telemetry; and
2. hosted processors, where a source Stream Durable Object currently wakes a
   processor and retains the callback returned with its durable checkpoint.

Durable delivery must resume exclusively after the last event offset actually
delivered and deduplicate any overlap by offset. A stream-level maximum or a
scanned-through offset is not a delivered cursor. Ephemeral events remain
live-only and may be lost at a transport seam; the API must make that explicit.

## Candidate A: rotate the outer callback transport

A prototype was implemented and then removed from PR #2378 to keep the
immediate mitigation small. Its commits are `9891c559f`, `54ed24692`,
`d411fc6bc`, and `748325517`. Preserve the design as a candidate, not a
decision.

### Client prototype

- Count inbound messages on the physical `/api` WebSocket and trigger at
  8,000, leaving margin below the old 10,000 default. This is only a proxy for
  subrequests and is the largest weakness of the trigger.
- Dial and authenticate a successor physical WebSocket before closing the
  predecessor. A new socket creates a fresh Worker invocation and budget.
- Publish the authenticated successor as a new session generation.
- Reconnect-aware callback effects keep their working predecessor callback,
  acquire a lease on the predecessor transport, and open the equivalent
  callback on the successor. They clean up the predecessor only after the
  successor callback establishes.
- Give unclaimed predecessors a five-second grace and claimed predecessors an
  absolute 30-second overlap bound. Transport retries carry the same lease and
  original deadline so retry storms cannot extend overlap forever.
- If a successor transport dies during handoff, transfer the live predecessor
  into the next attempt. If proactive successor authentication fails
  terminally, discard it and restore the still-authenticated predecessor.
  Ordinary authentication failure without a live predecessor still surfaces
  authority loss.

### Hosted-processor prototype

- After 8,000 successfully acknowledged callback batches, close the retained
  callback with the explicit audit reason `budget-rotation`.
- Keep expected rotation outside the delivery-failure/backoff ladder.
- Immediately issue a fresh durable processor wake. The processor returns its
  committed checkpoint and a new callback, and delivery resumes after that
  checkpoint.

### Costs and unresolved problems

- The prototype added roughly 800 changed lines across transport state,
  React handoff behavior, hosted delivery, tests, and documentation.
- Inbound message count and acknowledged batch count are not the actual
  subrequest counter. Multiple callbacks and ordinary RPC replies share the
  client counter, while different delivery paths spend different subrequests.
- The 8,000 threshold was calibrated to the old default. With a 10,000,000
  ceiling it causes much earlier churn than budget exhaustion requires.
- Correctness spans transport loss, authentication, React lifecycle ordering,
  non-React consumers, callback setup timeout, replay, deduplication, and
  bounded overlap. The state machine may be more complex than the value it
  provides.
- Make-before-break cannot preserve ephemeral events perfectly across every
  failure seam.

If rotation remains a contender, find a principled trigger or a server signal
instead of keeping the old 8,000-message magic number.

## Candidate B: a dedicated SSE fetch surface

Add a stream subscription endpoint that authenticates once, accepts an
exclusive replay cursor and filter, and returns `text/event-stream`. Determine
whether routing that fetch directly to the Stream Durable Object removes the
reverse-RPC subrequest chain or merely moves the same invocation budget. Define
backpressure, heartbeat, browser credential refresh, reconnect, filters, and
ephemeral semantics explicitly.

An SSE surface is attractive because the data flow matches the abstraction:
one response stream flowing outward instead of repeated calls into a callback.
It may also let browsers use native reconnection. It is not automatically
correct: native `EventSource` has header/auth constraints, the outer Worker may
still be pinned, and slow-consumer buffering must be bounded.

## Candidate C: a hibernatable Durable Object WebSocket

Investigate terminating a dedicated subscription WebSocket in the Stream
Durable Object using the WebSocket Hibernation API. The stateless OS Worker
would authenticate and route the upgrade, while the Stream DO would own socket
attachments and wake only for messages/events rather than retaining an active
outer callback invocation.

Prove whether the upgrade can be handed to the Stream DO without pinning the
stateless Worker or the DO, how project capability/authorization is represented
in a durable attachment, how credential revocation is enforced, and whether one
socket is needed per stream or can multiplex multiple stream subscriptions.

## Candidate D: a `ReadableStream` capability

Prototype returning a readable stream from the capability tree instead of a
reverse callback. Inspect Cap'n Web's actual wire behavior rather than assuming
that a JavaScript `ReadableStream` changes the Cloudflare topology: determine
whether each chunk becomes another RPC call/frame charged to the same outer
invocation, whether backpressure crosses the WebSocket, and how cancellation
and resume cursors work.

This may be the cleanest public API if Cap'n Web transports streams as a native
flow with bounded buffering. It is only useful if measurement proves it avoids
or makes recoverable the current budget failure.

## Candidate E: cursor-based pull or long polling

Expose a bounded `readAfter(offset, limit, waitMs?)` operation and make the
consumer own a durable polling loop. This avoids retained reverse capabilities
and makes every request budget finite and failure-visible. Measure the latency,
request volume, thundering-herd behavior, and ephemeral-event contract. A
long-poll variant may be a simpler reliability baseline even if another
transport remains the optimized path.

## Required experiments

1. Keep a deterministic deployed-preview repro for the current callback model.
   Record physical socket identity, delivered offsets, callback batches,
   append success, close/error signals, Worker version, and Cloudflare trace.
2. Measure each candidate at the same rates and duration. Include at least the
   120 events/s cutoff repro and multi-hour 50 events/s traffic, plus multiple
   concurrent callbacks sharing one client/session.
3. Inspect Cloudflare outcomes and logs for `exceededResources` / `Too many
   subrequests`, and add our own bounded delivery-progress signal so a silent
   stall is observable even when Cloudflare emits nothing useful.
4. Measure whether the stateless Worker invocation or Stream Durable Object is
   kept active, including DO duration/cost and behavior across eviction,
   deployment, storage reset, network suspension, and credential changes.
5. Exercise slow consumers and backpressure. Memory and queued bytes must be
   bounded; overload must close or reject with an explicit recoverable reason.
6. Verify durable replay, overlap deduplication, filters, state-only callbacks,
   and the explicit loss boundary for ephemeral events.
7. Verify hosted processors independently. A browser transport that works does
   not solve the retained processor callback unless the chosen model covers it
   or replaces it with a different durable delivery lane.

## Exit criteria

- An architecture note compares the candidates with measured subrequest use,
  active-time/cost, backpressure, auth, replay, and failure behavior.
- The selected transport cannot stop silently: it either continues, reconnects
  within a bounded interval, or emits a durable/observable classified failure.
- A red test reproduces the old cutoff and becomes green through the selected
  design without relying on an arbitrary event-count threshold.
- Sustained preview runs deliver every durable event with no gaps or duplicates
  and coherent Cloudflare traces/logs at the exact deployed version.
- Browser, Node/TUI, and hosted-processor contracts are documented, including
  cursor ownership and ephemeral loss.
- Any temporary mitigation retained from PR #2378 is reassessed after the new
  transport ships; the 10,000,000 ceiling should remain an explicit finite
  guardrail, not the correctness mechanism.
