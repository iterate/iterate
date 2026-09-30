# Opus review: keeping durable bodies in the context (round 8)

**Method.** Claude Opus 5.5 xhigh reviewed commit `a9f75277f` read-only. Raw response: `/tmp/core-simplification-opus/round-8.json`; canonical model `claude-opus-5-5`, 28,326 thinking tokens, no web searches. Prompt: `/tmp/core-simplification-opus/round-8-prompt.md`.

## Decision

Choose **B**: durable event bodies do not leave the context. The private facet persists cursor/range or selected offsets; the context reads durable source rows synchronously, filters under the current row, charges a single active target-body ledger, derives the caller, resolves the target, and releases bytes only when the target really settles. This makes the second context read durable proof rather than duplicate transport work.

Option A improves transient source reading but retains two ledgers for the same selected bytes, a facet waiter queue, facet-trusted bodies, and two RPC serializations. A large selected page still blocks unrelated small work. B removes those mechanisms and makes real fan-out concurrency possible.

## Why this removes the root cause

At `a9f75277f`, the facet has a single whole-facet 8 MiB read lease held through target settlement. It serializes all ordered work and makes fan-out's configured concurrency effectively one. Releasing it at the delivery deadline is not a cure: the facet has dropped its lease but the context is still executing a native target call and holding the bodies.

The context already has the only lifetime boundary that matches this call: its active delivery frame. It should own the one active-byte ledger. A busy result occurs before target evaluation and does not consume an attempt or retain a waiting page. A first legal event larger than the normal capacity is admitted alone when no target body is active, matching the existing delivery-budget rule.

## Minimal private shape

1. **Push only what cannot be recovered.** `processEventBatch` receives current row identities, durable scanned range, subscription control signal, and ephemeral bodies for rows that consume them. It never receives durable bodies. This also removes the unbudgeted all-event durable push.

2. **Metadata read.** `readSubscriptionDelivery({ name, configuredAtOffset, resumeAtOffset }, after, limit)` reads durable rows only, validates current row identity, filters `consumes` synchronously, and returns `{ offsets, scannedThroughOffset, atHead }`. The full source page is discarded before any await. The runner needs no types, paths, event bodies, or hashes.

3. **Durable delivery.** The private bridge accepts identity and range, never durable event bodies. It fences the row and resume state, synchronously reads `(after, through]` with an upper through bound, filters/measures, admits its active byte ledger, discards transient page references, then hashes (fan-out), resolves, fences again, invokes, and releases on settlement. The existing durable mark check remains essential to prevent reuse of ephemeral offsets.

4. **Ephemeral delivery.** Keep the current one-event body path and facet budget because an ephemeral cannot be reconstructed after its push. It must share an ordered row's delivery chain, so it cannot overtake an ordered durable pending range.

5. **Busy / replay.** Preserve the persisted cursor, pending range and fan-out offsets. A retry directly asks the context to deliver the persisted range; it does not issue a full read. Context single-flight and short settled-outcome record provide late-success joining. A read failure must schedule a wake rather than leave a row asleep.

## Checks to retain

- identity, configured generation, resume and halt fences before local read and immediately before invoke;
- monotonic range and `through <= highestDurableOffset`;
- fan-out exactly one selected event;
- context-derived event cause, write key and delivery hash;
- per-row single-flight and one active target-body ledger.

The native channel is platform-only, so its TypeScript private argument can replace the payload schema's body shape validation. Do not weaken durable mark or fence checks.

## Important current gaps at reviewed head

- the context's full-page read includes ephemerals though durable runners discard them;
- the push carries all commit bodies to the facet without a budget;
- current body validation does not establish complete source content, yet caller cause/hash depend on those bodies;
- bridge busy is returned after full payload transfer; polling rows re-read every second;
- a thrown read can clear the only wake/claim and leave a row asleep;
- a raw configured row can still arrange deletion of the `subscriptions` facet unless its name is refused at core hosting/append/rule boundaries.

The root reported a post-review improvement: subscriptions configuration is now derived natively from core state on revive rather than persisted in the facet, and disposed runners invalidate their generation. That is aligned with B: it removes a second configuration cache and makes a pre-push claim recoverable after a lost async push. It should be covered by a revive-before-push and late-outcome-after-dispose test. The Opus review itself was pinned to `a9f75277f` and did not inspect those later dirty edits.

## Proof and telemetry

- One 7 MiB slow target plus twenty tiny disjoint rows: tiny rows settle while it remains active; context active bytes remain bounded; active deliveries exceed one.
- Two 5 MiB slow rows: second gets busy with `attempt === 0`, then delivers after the first settles.
- Fan-out slow targets actually overlap up to configured concurrency.
- Durable body injection or omission cannot alter target input, cause, or fan-out hash.
- Resume/replace during local reread or evaluation performs no stale call.
- Ordered retry and fan-out retry make zero metadata reads; throwing metadata read schedules a wake.
- Ephemeral-only commits make no durable facet write; a noncontiguous range falls back to source repair.

Measure active target bytes/count/oldest age, busy reasons, selected versus scanned bytes, re-read duration, facet push bytes, and metadata/read counts. Remove facet read-lease and waiter telemetry once B replaces it.
