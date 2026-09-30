# Opus review: direct private subscription delivery (round 7)

**Method.** Claude Opus 5.5 xhigh read the current dirty source snapshot only and changed nothing. The raw response is `/tmp/core-simplification-opus/round-7.json`; it records canonical model `claude-opus-5-5`, 57,469 thinking tokens and no web searches. Prompt: `/tmp/core-simplification-opus/round-7-prompt.md`.

## Decision

The direct private facet-to-context handoff is the right direction. The context must own event-body lifetime until the actual target call settles. The present context-side body counter has that correct ownership, including across facet restarts. A `Promise.race` deadline only releases the facet's local work; it cannot cancel the native target call.

The review found four blocking semantic gaps: backpressure currently consumes delivery attempts; single-flight is keyed by range rather than by row; late successes are not observed; and the claimed page lease has no backing reservation. It also found user-controlled deletion of the private facet and stale resume state captured by a runner closure.

## Required private invariants

1. **One active entry per logical delivery.** Use `name@configuredAtOffset` for ordered rows and append the event offset for fan-out. Do not include the resume generation, so a resumed row cannot overlap an earlier call still running. Hold body bytes in the context ledger until the underlying target promise settles.

2. **Busy is not an attempt.** If the same entry is running, join its promise; if a different entry for the row is running or the ledger has no space, return one private retryable busy refusal. The SDK schedules a short retry without incrementing `attempt`. Retain a very short settled result per entry so a late success confirms instead of invoking the target again.

3. **Bound all body paths through one context ledger.** A first large event should be admitted alone rather than rejected forever. Delivery pages need a smaller byte limit and should exclude ephemerals. The current three separate 8 MiB budgets do not bound aggregate context residency. The facet needs a modest FIFO slot pool acquired before reads, with one slot for ordered rows and its normal concurrency for fan-out. This prevents a single row monopolising all reads while avoiding global serialization.

4. **The private facet cannot be user-hosted or deleted.** Refusing only built-in verbs is insufficient: raw subscription configuration can still resolve to `builtins.facets.get("subscriptions")` and removal causes `FacetHost` to delete its cursor storage. `facetSpecFromHostingTarget` and the append/rule boundary must refuse this name. The private code may delete the facet only when no durable rows remain.

5. **A runner closure captures identity only.** It currently passes the `resumedAtOffset` of the row from runner construction rather than the current delivery input. Resuming without replacing the configured row makes every later call fail the context resume fence and halt again. Pass `input.resumeAtOffset`; do not close over mutable row facts.

6. **Use one private claim helper.** Extract ProcessorEngine's first-work/last-work, ordered claim chain and revive-backoff logic. The facet currently awaits claim before work, can wedge when that claim rejects, and allows stale release calls to overtake newer claims. Its helper only needs `run`, `wake`, and `revived`; it is not a scheduler and changes no processor public API.

## Direct bridge checks

The bridge's fence timing is sound. With the native direct channel, keep the row/configuration/resume/halt fence before hashing, after hashing, and immediately before invocation. Keep cheap range ordering, durable-mark, fan-out cardinality, ephemeral-single-event, and `consumes` checks. The host derives cause and delivery hash.

The Zod schema and per-event structural checks add no authority once only the platform facet calls the direct DO method. They may be replaced by typed private parameters, but do not remove durable-mark validation: it prevents reuse of ephemeral offsets as durable data.

## Performance path

Persist pending before the first target call, then deliver from the admission page. Reread only for retries or after restart. At the context, skip a facet push unless a durable row consumes a new durable event or the batch has subscription control events. The first safe fast path is an idle row whose cursor equals the pushed durable `after`; any gap, busy row, or fresh incarnation falls back to the current read path. This retains replay/catch-up correctness while eliminating duplicate first-attempt reads and irrelevant pushes.

Ordered ephemerals must use the same row chain as durable work. Their separate queue currently allows an ephemeral target call to overlap or overtake an ordered durable one.

## Focused proof

- Late success after deadline: one target invocation and a confirmed cursor.
- Hung row beside successful rows: only the hung row stays charged; busy refusals do not consume attempts.
- Read-page plus JSON overhead and a large single event: both admit without permanent failure.
- Fan-out pressure: bounded ledger and facet slots, no dead letters caused by capacity.
- Raw subscription target naming `subscriptions` is refused and cannot erase cursors.
- Resume without facet reconstruction delivers successfully.
- Rejected claim never wedges a runner; revive while busy reclaims with backoff.
- First attempt from push reads zero pages; irrelevant and ephemeral-only commits produce no delivery work or facet storage write; a gap falls back to read repair.

Measure ledger chars/entry count/oldest active age, busy reason, joins/late settlements, slot occupancy, delivery reads per commit, skipped pushes, and admission source.

The complete source-anchored Opus report remains in the raw JSON referenced above.
