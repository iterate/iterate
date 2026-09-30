# Durable delivery source review: round 10

Actual Claude Opus 5.5 xhigh; 74,601 thinking tokens. The requested frozen
snapshot was inaccessible to its restricted Read tool. It instead inspected
the mutable implementation tree. This is explicitly source analysis, not an
immutable-head review or test result.

# Round 10 review: durable delivery (working tree, not the frozen snapshot)

**I could not read the frozen snapshot.** `--restricted` limits Read to `/private/tmp/iterate-core-simplification-resumed`, so `/tmp/core-simplification-opus/round-10-source` and its manifest were out of reach. Everything below comes from the working tree (30875b8b9 plus the uncommitted changes). It contains every Round 9 fix I checked, but I can't confirm it matches the fingerprinted snapshot, so diff the two before acting. I ran no tests.

## Round 9 fixes, checked against the working tree

- **Fan-out target refusal halts the row and keeps its pending items:** `packages/iterate/src/stream/durable-delivery.ts:693-712` ✓
- **Later pages are still admitted past a backed-off item:** `durable-delivery.ts:613-616` ✓
- **Running ordered resume honours a seek:** `durable-delivery.ts:264-270` ✓ (see D1)
- **An oversized legal envelope is admitted alone:** `apps/os/src/iterate-context-durable-object.ts:1048-1056` ✓
- **A cold push pulls the current configuration:** `apps/os/src/subscription-delivery-durable-object.ts:118-124` ✓
- **High-water mark is in memory only:** `subscription-delivery-durable-object.ts:79`, legacy key deleted at `:107` ✓. The sweep exception for that key at `:239` is now dead code.
- **Orphan cursors are swept once per instance:** `subscription-delivery-durable-object.ts:192-195` ✓
- **Claim release is captured at enqueue and validated in the context:** `packages/iterate/src/stream/background-claims.ts:45-58` and `iterate-context-durable-object.ts:907-922` ✓
- **20 s recovery claim before the push, and irrelevant pushes are skipped:** `iterate-context-durable-object.ts:832-846` ✓
- **The facet no longer pretends to be a StreamProcessor:** ✓, but the unused `_range` parameter remains.
- **Public read is strict, while rebuilding core state skips one bad row:** `apps/os/src/stream/stream.ts:668-681` ✓ (see D3)
- **Deep JSON compare for ephemerals:** `iterate-context-durable-object.ts:1006` ✓ (proposal A can delete it)
- **Attaching a new name skips the 5 s lease wait:** not checked. `rpc-stubs` was outside the files I read.

## New defects found in the source

**D1: a resume without a seek on a running row sends it into a silent 1 s loop.**

- Core accepts `subscription-delivery-resumed` on any row (`apps/os/src/stream/core-processor.ts:636-650`).
- The facet calls `resume(undefined, undefined, R)` and records the resume marker (`subscription-delivery-durable-object.ts:224-230`).
- But `resume()` returns at `durable-delivery.ts:264` without adopting R as `#resumeAtOffset`.
- Every later read and delivery carries the old fence, so the context answers GONE (`iterate-context-durable-object.ts:1159-1162`).
- The read catch (or `staleResume`) retries every 1 s without spending an attempt, and the marker stops the resume from being applied again.
- This lasts until the facet instance is replaced, and the 1 s alarm/revive loop keeps it alive. A fan-out row that hasn't admitted anything yet hits the same path.
- **Fix:** delete line 264. `resume()` then always adopts the new fence, drops the pending range and re-scans from `confirmedOffset`.
- Don't adopt the fence while keeping pending. `#isCurrentPending` would compare the rewritten pending against the stale local copy, silently discard the outcome and schedule no wake.

**D2: a fan-out seek is ignored after the first admission.** `durable-delivery.ts:235-239` prefers the existing `cursor.fanOut`, so `afterOffset` is thrown away once anything has been admitted. The only test (`durable-delivery.model.test.ts:218`) covers the case before admission.

- **Fix:** when `afterOffset !== undefined`, use `{ admittedThrough: afterOffset, pending: [] }` plus the selective `offset`. That mirrors the ordered seek.

**D3: a corrupt stored row causes a silent, unbounded 1 s loop.**

- `readSubscriptionDelivery` uses the strict public read (`iterate-context-durable-object.ts:894` → `stream.ts:678`).
- The runner's read catch swallows the error and retries at 1 s, with no report and no attempt counted (`durable-delivery.ts:366-370`, `:563-567`).
- The proof read (`iterate-context-durable-object.ts:977`) and the halt receipt's cause read (`:1197`) are strict too, so even a halt would then loop on its receipt.
- **Smallest fix:** let those three private bridge reads use the existing `skipUnreadable` path that core rebuilding already uses (it reports each skipped row). The metadata read, proof read and receipt then agree. There is no body to deliver, and core already treats the row as absent. Also report the error in the runner's read catch.

**D4: ordered delivery reorders ephemerals behind later durable events.**

- Admission takes the whole scanned page (`durable-delivery.ts:357-399`), and ephemerals only drain once caught up (`:375-381`).
- Example: durable 10, ephemeral 11, durable 12 are delivered as `[10,12]` and then 11.
- Under steady durable traffic, ephemerals starve until the ring evicts them.
- Proposal A's cut fixes this.

## B: join the in-flight call instead of caching successes

**Does B keep any promised dedup?** No, but nothing is lost, because no dedup was ever promised.

- The one real guarantee is single-flight: one raw call per row key within one context instance. The in-flight map provides that with or without the cache.
- The 40 s cache is already best effort:
  - It is per instance, so a restart clears it.
  - It holds 128 entries, which fan-out churns through.
  - It stores successes only.
  - It misses whenever the next retry lands more than 40 s after a late success, and the backoff after attempt 7 is at least 64 s.
- Your counterexample is right: with join alone, a raw call that settles between the facet's 20 s deadline and the next scheduled retry gets invoked a second time.
- So delivery is at-least-once today and stays that way. Receivers dedupe by offsets (ordered) or by the `writeKey`/`delivery` hash (fan-out).

**What join actually buys is a bound, not dedup.** A joined retry still sits under the runner's 20 s deadline. A wedged raw call for the same request therefore becomes ordinary counted timeouts on the existing retry ladder, ending in a halt receipt at `maxAttempts`. Today the same wedge is a free 1 s busy loop that never ends.

The change is context-only; the runner and the cursor stay as they are:

```ts
#configuredSubscriptionDeliveries = new Map<string, { requestKey: string; startedAt: number; settled: Promise<void> }>();
// before the source read in deliverConfiguredSubscription, and in the ephemeral path:
const held = map.get(rowKey);
if (held?.requestKey === requestKey) return await held.settled; // join
if (held) throw busy(held.startedAt);
// on a body-budget refusal: throw busy(oldest startedAt in the map)
const busy = (since: number) =>
  codedError("UNAVAILABLE", "configured subscription delivery is busy",
    Date.now() - since < 20_000 ? { deliveryBusy: true } : undefined);
```

- Delete `#settledConfiguredSubscriptionDeliveries`, `#rememberConfiguredSubscriptionDelivery` and the 40 s sweep.
- In `finally`, delete the map entry only if it is still the same entry.
- The body reservation stays in `#invokeConfiguredSubscriptionDelivery`'s `finally`, so it still lasts until the raw call settles.

**Bounds:**

- **Same request:** it joins, timeouts count as attempts, and the row halts at `maxAttempts`.
- **Every other busy case** (a different request on the key, meaning an older resume generation or an ordered ephemeral, or the body budget): it's free only while the blocking call is younger than one call deadline, so at most about 20 wakes at 1 s. After that it's an ordinary counted UNAVAILABLE on the ladder.
- **Joined waiters:** at most one pending RPC handler per attempt per request key.

**Tradeoff:** if one row's raw call stays wedged for hours while holding budget, the rows competing with it spend attempts and can halt after the full ladder (about 2 h by default, longer for webhooks). They can be resumed, and the context genuinely can't deliver bodies meanwhile. Single-flight still doesn't span context restarts, same as today.

**Tests for B:**

- A target that takes about 25 s is invoked once (the retry joins).
- A target that settles at about 20.5 s is invoked twice. This test documents at-least-once.
- A blocker younger than 20 s leaves `attempt` at 0. The existing "second 5MiB target waits busy" test stays valid.
- A blocker older than 20 s makes attempts grow and halts the row; do this in a runner unit test with `maxAttempts: 2`.
- A resume while an old-generation call is in flight: the new generation gets busy, then proceeds after release.

## A: send ephemeral offsets instead of bodies. Correct, and pure deletion

**The facet's copy of the body is never delivered.** `deliverConfiguredEphemeralSubscription` already requires the event to still be in the context's 1 MiB ring. It delivers the ring's object and only uses the pushed body for a `jsonEqual` compare (`iterate-context-durable-object.ts:1003-1008`). So A changes nothing about when ephemerals get lost. It deletes:

- the facet's 8 MiB budget and leases (`subscription-delivery-durable-object.ts:81-82`, `:313-329`)
- `tryReservePendingEphemeral`
- the runner's character budget
- `deliveryResourceSnapshot` and `pendingEphemeralChars` in the status
- the passthrough `event` in the bridge schema
- the deep compare
- the `read(offset-1, 1, includeEphemeral)` lookup, which reads a durable body just to find a ring entry

It also removes a push that can carry a whole commit's ephemeral bodies, together with the configuration, over one 32 MiB RPC (`iterate-context-durable-object.ts:842-849`).

**Shape:**

- The context pushes `{ offset, type }[]` plus `incarnation`.
- The runner queues `{ offset, incarnation, resumeAtOffset }`, capped by count, dropping the oldest with the existing warning.
- `deliverEphemeral({ offset, incarnation, resumeAtOffset })`. The context checks the incarnation, looks the event up in the ring by offset, then applies `consumesEvent` and the row fence.
- **The ordering cut, at admission:**
  - Drop queued offsets that are at or below the admitted-through offset; they've already been overtaken. Log a warning.
  - Let `e` be the earliest queued offset. If `e === confirmedOffset + 1`, deliver it now.
  - Otherwise cap `through` at `min(scannedThroughOffset, e − 1)` and filter the offsets.
  - A cut `through` is always below the durable mark, so persisting it is safe.

**Conditions:**

- The incarnation is the fence for equal ephemeral offsets across context restarts. The facet can outlive a context incarnation.
- `storage.incarnation` is only sound if the push is output-gated behind `countIncarnation()`. If facet calls aren't gated, use a random per-instance token instead; it needs no persistence.
- The resume fence captured at enqueue stays on each entry.

**Tests for A:**

- Durable 10, ephemeral 11, durable 12 are delivered in that order.
- An overtaken ephemeral is dropped.
- A queued offset from a previous incarnation is refused even when the new ring holds a different ephemeral at that offset.
- The queue cap drops the oldest entries.
- The status shape is updated; the memory workers test types `Status`.

## C: remove dead plumbing

- **`deliveryKey`:** dead. The facet runtime drops it, and the strict bridge schema would reject it anyway. Delete it at `durable-delivery.ts:57`, `:420` and `:641`; no behaviour change.
- **`_range`:** delete it from the facet's `processEventBatch` (`subscription-delivery-durable-object.ts:114`) and from `#pushDurableSubscriptionFacet`/`onCommit` (`iterate-context-durable-object.ts:497`, `:807-809`).
- **Legacy high-water key:** also delete the constructor delete and the sweep exception (`subscription-delivery-durable-object.ts:107`, `:239`). The one-time sweep already removes keys it doesn't recognise.
- **Merging the resume marker into the cursor:** worth doing only with one rule.
  - `#putCursor` must stamp `resumeAtOffset: this.#resumeAtOffset` on every write, and `resume()` must compare against that stored stamp.
  - Without that, any plain `{ confirmedOffset }` rewrite drops the stamp, and a seek resume gets re-applied and rewinds progress on the next push.
  - With it, the merge deletes the `durable-delivery-resumed/*` keys (`subscription-delivery-durable-object.ts:190`, `:224-230`, `:242-245`) and covers the D1 fix.
  - The return values of `resume()` and `halt()` are then only used by tests.
- **`urls.os`:** first make `appConfigOf` reject a missing `urls.os` in every environment, including a workers.dev self-host, local dev and tests.
  - Expect loaded facets to restart once, because the loader id folds in the origin.
  - Either leave the `platform-origin` KV entry or delete it opportunistically.
  - I didn't read those code paths beyond the constructor.

## Recommended order

1. The C deletions (`deliveryKey`, `_range`, the dead legacy key). No behaviour change.
2. D1 (delete one line, add a test), then D2 and D3.
3. B: join, busy that is free only while the blocker is young, and remove the cache.
4. A: offset-only ephemerals with the ordering cut. This also fixes D4.
5. The resume-marker merge.
6. `urls.os`, as the separate piece of work already in flight.

For each step, run the durable-delivery unit and model suites plus the seven workers suites changed on this branch.
