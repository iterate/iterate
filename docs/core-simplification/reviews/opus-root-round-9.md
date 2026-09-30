# Full-access source review: round 9

**Review source:** `/tmp/core-simplification-opus/round-9-root.json`  
**Source read:** mutable working tree beginning at `30875b8b9`; not an immutable review  
**Review mode:** read-only source inspection; no commands or tests  
**Model:** Claude Opus 5.5, xhigh thinking; 68,047 thinking tokens, 78,635 output tokens, 797,074 ms model duration.

This is an audit record, not a validation result. The review could not inspect
the diff or locate Workers-level tests. The implementation worktree changed
after the `30875b8b9` run, so that revision identifies the reviewed and tested
starting point; it is not an immutable release candidate.

The review says not to release the private durable-delivery shape yet. Its
highest-impact findings were:

- fan-out catch-up stopped reading later pages while one earlier item backed
  off, leaving spare capacity idle;
- a non-settling target could cause a one-second busy wake/claim loop without
  a terminal outcome;
- a multi-event selection above the normal body budget could remain busy
  forever even when the context was otherwise idle;
- ephemeral delivery might fall behind a later durable range;
- configuration, claim release, resume, and stale cursor cleanup still need
  recovery proofs.

It also found a small simplification path: keep durable bodies in the context,
not the subscriptions facet; avoid a permanent body cache; continue fan-out
admission while capacity remains; and admit one otherwise-idle request within
the existing 32 MiB RPC limit. It proposed ephemeral offsets and awaiting an
active target call as possible further cuts, but both change established
behaviour and require explicit decisions and Workers evidence.

The associated findings, full-access run counts, repair status, and validation
limits are recorded in [the main findings report](../findings.md#round-9-full-access-failures-and-a-second-delivery-audit).

## Complete independent review

The text below records the source review at its checkpoint. Subsequent fixes
and test evidence take precedence; recommendations are not implementation proof.

# Review of `30875b8b9`: private durable delivery (read-only)

**Short answer:** don't release this shape as final yet. I found three bugs that can wedge delivery or keep it looping without end, plus several smaller defects. Most of the fixes are small and remove code.

**Scope.** I read the working tree, which the session's git status reports as clean at `30875b8b9`. I couldn't view the diff itself or list directories, so I read these files directly: the context DO, the subscriptions facet, the delivery bridge, `durable-delivery.ts` and its unit tests, `background-claims.ts`, `facet-host.ts`, the subscription parts of `core-processor.ts`, `subscription-delivery.ts`, and the header of `stream.ts`. I guessed several paths for the Workers-level delivery tests and didn't find them, so nothing below claims Workers test coverage.

File abbreviations used below:

- ctx = `apps/os/src/iterate-context-durable-object.ts`
- sdf = `apps/os/src/subscription-delivery-durable-object.ts`
- dd = `packages/iterate/src/stream/durable-delivery.ts`
- fh = `apps/os/src/context/facet-host.ts`
- core = `apps/os/src/stream/core-processor.ts`

## Source-backed defects, most serious first

**1. Fan-out stops admitting new events while any one event is in backoff.**

- **Where:** `dd:638-642` only reads the next page when `settled.pending.length === 0`.
- **What happens:** if one item is waiting on a retry and the last page wasn't at the head of the log, the runner schedules that item's wake and stops, even though `room > 0`.
- **Impact:** a catch-up (`afterOffset: 0`), or a backlog with one failing webhook event, waits up to `retryCapMs` (4 h, `ctx:865-868`) per page unless another commit happens to push. That breaks fan-out's promise that each event progresses independently.
- **Fix:** when `!admittedAtHead` and there's still room, read the next page before calling `scheduleWake`.

**2. A target that never answers causes a 1-second alarm loop that never ends.**

- **Where:** a "busy" answer keeps the attempt count and always retries after `busyRetryDelayMs = 1_000` (`dd:107, 458-469`). The context holds `rowKey` until the raw call settles (`ctx:1012-1019`), and it doesn't bound that call.
- **What happens:** a target that never settles (a lent stub, an external Cap'n Web peer) never halts. Every second: `scheduleWake → #syncClaim → claim → alarm → reviveDueClaims → revive → subscriptionDeliveryConfiguration → drain → deliver → busy`, plus a cursor write.
- **Also:** the same loop runs for every row turned away because the body budget is exhausted (`ctx:1047-1049`).

**3. An ordered batch of several events over 8 MiB is refused forever.**

- **Where:** `admittedAlone` requires `events.length === 1` (`ctx:1031-1034`). Any other request with `bodyChars > 8 MiB` gets "busy", even when nothing else is in flight (`ctx:1036-1039`).
- **Why it can happen:** the stream's page budget counts UTF-8 bytes of the stored bodies (`stream.ts:51-54`). The context's budget counts `JSON.stringify(events)`, which includes the event envelope; `ctx:464-465` already admits the envelope can overflow. So two roughly 4 MiB ASCII events that fit in one page can serialize to more than 8 MiB.
- **Impact:** that row is stuck for good, because "busy" never uses up an attempt (see 2).
- **Fix:** delete the event-count condition and admit any request of up to 32 MiB when nothing else is held.

**4. Ephemeral and durable events can be delivered out of offset order.**

- **Where:** ephemerals are only sent once the cursor is at the head of the log (`dd:404-407`).
- **What happens:** if a durable event D commits before the drain reads the log, an earlier ephemeral E (offset lower than D) is delivered after D's range. That range, `(C, T ≥ E]`, already claimed to cover E. E then arrives with range `(E-1, E]` (`ctx:944`).
- **Impact:** a target that checks that ranges line up will see E as stale or duplicated.
- **Test gap:** the unit test "ordered ephemerals share the persisted delivery chain" doesn't check the order.

**5. The facet's "release" can cancel the context's safety claim.**

- **Where:** on each commit with durable work, the context writes `claim("subscriptions", now)` (`ctx:831-832`). When the facet's work settles, `BackgroundClaims.settled()` and `#syncClaim()` send `at(null)` (`sdf:331-337`), and `claimSubscriptionDelivery` applies it without any check (`ctx:897-900`).
- **What happens:** if that release arrives after the commit's claim, and the context instance dies before the facet's next claim (sent from `started()`) arrives, nothing is left to wake the context.
- **Impact:** the window is about one round trip, but on an idle context the stall lasts until something else wakes it.

**6. A freshly started facet discards a slightly stale push instead of catching up.**

- **Where:** `sdf:106-113` fetches the current configuration, then simply `return`s if the push was older.
- **What happens:** it never applies the newer configuration it just fetched and never records a high-water mark. While commits keep arriving, every push can repeat the same fetch-and-discard. Only the claim/revive path fixes it.
- **Fix:** delete the `return` and apply the fetched configuration.

**7. One stuck row can use the entire ephemeral budget.**

- **Where:** each runner may queue up to 8 MiB (`dd:103, 203-212`), which is the same as the whole facet's limit (`sdf:85, 284-300`).
- **What happens:** an ordered row whose durable range is in backoff doesn't deliver ephemerals, so its queued bodies stay reserved for the whole backoff. Meanwhile every other row drops its new ephemerals.
- **Also:** most of those queued bodies can't be delivered anyway. The context checks each one against a 1 MiB ring of recent ephemerals (`stream.ts:86`, `ctx:982-990`).

**8. The success-only settlement cache works only some of the time.**

- **Where:** entries live 40 s, the cache holds 128, and every success is recorded, including on-time ones (`ctx:1003-1007, 1016, 1094-1102`).
- **What happens:** a late success followed by a retry delay of 64 s or more (attempt 7 and up), or more than 128 fan-out successes in 40 s, pushes the entry out. The target is then invoked again.
- **Also:** the cache is only checked after `#durableSubscriptionDeliveryEvents` has already loaded the event bodies.

**9. Every commit with durable work drives each row twice, and unrelated commits still cost work.**

- The immediate claim (`now`) fires an alarm that revives the facet, fetches configuration, and drives every row. The push has already done the same (`sdf:116-123, 132-138`).
- Every commit on a context with at least one durable row pushes to the facet, including ephemeral-only commits nobody consumes. Each push costs one metadata read call per non-halted row (`ctx:837-841`).
- `#reconcile` writes the high-water mark to storage on every durable commit (`sdf:166-167`).
- Every call to `FacetHost.claim` clears the revive-failure count (`fh:375-377`).

**10. A "resume with seek" on a running ordered row is silently ignored.**

- **Where:** core documents a resume as "a seek, an un-halt" (`core:288-290`), but `resume()` returns early unless the row is halted (`dd:275`). `#reconcile` still records the resume as applied (`sdf:209-215`).
- **Side effect:** the generation bump discards any success still in flight, so the same range is invoked again under a new `requestKey`.
- **Also:** a fan-out runner with no `fanOut` cursor yet drops a resume that targets one `offset`.
- **Action:** decide whether this is intended, then pin it with a test.

**11. Cursor keys are left behind.**

- Only runners held in memory are cleaned up (`sdf:170-180`).
- After a facet restart, a replaced or removed row's `durable-delivery/<key>` and `durable-delivery-resumed/<key>` stay until the whole facet is deleted.
- A fan-out cursor can hold up to 1,000 items.

**12. Dead or loose code.**

- `drive()` (`dd:244`) isn't called by the facet.
- `deliveryKey` (`dd:67, 449, 662`) is ignored by the runtime (`sdf:242`), and `_range` is unused.
- Webhook `maxAttempts`/`retryCapMs` are fixed when the runner is created (`sdf:184-197`), although `targetIsWebhook` changes with rules.
- A facet claim arriving after `deleteFirstPartyFacet` recreates `facet-claim:subscriptions` and `facet-ran:` (`ctx:897-900`, `fh:1443-1464`). That revives an empty facet, which is then started at every birth.

**What checked out:**

- Row, resume and halt checks run both before and after each await (`ctx:1064, 1079, 1111-1121`).
- Only one call runs at a time per row, and per event offset for fan-out.
- The body budget is released only in `finally`, after the call really settles (`ctx:1088-1090`).
- Late results are ignored after a dispose or generation change (unit-tested).
- Terminal records use idempotency keys that include the resume identity (`ctx:1147, 1157`).
- A failed read doesn't use up an attempt (tested).
- Ephemerals never enter a cursor.

## Speculative concerns (need a probe)

- **Subrequest depth.** Durable delivery now descends from the committer's request: push → facet `waitUntil` → context `deliver…` → target. That's two more hops than before, and it's the same problem that moved script runs onto the alarm (`ctx:1291-1302`). Durable rows chained across contexts may hit the limit.
- **Cursor stored separately from the log.** The cursor is saved in the facet's storage, not in the same transaction as the context's commit. If the storage-reset defect (`fh:97-113`) loses a context commit after the facet already read it, a cursor can end up past the durable mark. Once offsets are reused, a confirmed cursor would skip events, and a pending range would hit `ctx:954-955` (GONE) and then halt. Whether this can happen depends on whether calls to facets wait for storage writes to be confirmed. Processor facets have the same exposure.
- **Large single events starving.** A single event of 8–32 MiB is only admitted when nothing at all is in flight, which may never happen under steady small deliveries.

## Smallest deletion path

Each step removes a mechanism or merges it into one that already exists. None adds a registry, a new taxonomy, or a state machine in the SDK.

**A. Send ephemeral offsets, not bodies.**

- The push carries `[offset]` for consumed ephemerals. The runner queues `{offset, resumeAtOffset}`, capped by count, dropping the oldest.
- The context looks the event up in its ring, as it already does (`ctx:982-984`), and checks core's `incarnation` instead of comparing JSON.
- **Deletes:** `#pendingEphemeralChars`, `#reservePendingEphemeral`, `deliveryResourceSnapshot`/`pendingEphemeralChars`, `tryReservePendingEphemeral`, the runner's leases and size counting, and the bridge's body passthrough.
- **Result:** bodies never enter the facet, the ring becomes the only limit on ephemerals, and defect 7 goes away.
- **Also fixes 4:** in the same loop, cut an ordered range's `through` to just before the first queued ephemeral's offset. That's a few lines.

**B. Wait for the in-flight call instead of caching successes.**

- Make `#configuredSubscriptionDeliveries` a `Map<rowKey, {requestKey, startedAt, settled}>`.
- A retry with the same `requestKey` awaits `settled`, before any read; a different request gets "busy".
- **Deletes:** `#settledConfiguredSubscriptionDeliveries`, the 40 s expiry sweep, the 128 cap, and `#rememberConfiguredSubscriptionDelivery`. This fixes 8.
- **Limits 2:** a retry that waits past the runner's deadline now counts as an attempt, so a target that never answers halts at `maxAttempts`.
- **Trade-off:** this changes the rule that "busy never uses an attempt". I'd accept that. If you keep the rule, at least make busy retries wait `retryDelay(max(attempt, 1))` instead of a fixed 1 s.

**C. Simplify admission.** Remove `events.length === 1` from `admittedAlone`. This fixes 3.

**D. One driver and one claim.**

- Delete the high-water mark saved to storage and keep only the in-memory one; a restarted facet already fetches configuration. Remove the cold-start `return`. This fixes 6 and saves a storage write per commit.
- Claim `now + REVIVE_AFTER_MS`, and only when no earlier claim is held, instead of claiming `now` on every commit. This removes the double drive in 9.
- Have the facet send its accepted high-water with a release, and keep the claim if the last commit with durable work is past it. This fixes 5.
- Return early from `#pushDurableSubscriptionFacet` when there's no configuration change, no durable work due, and no consumed ephemeral.

**E. Fold the resume marker into the cursor.** Store an applied-resume field in `DurableDeliveryCursor`, and when a facet starts, sweep any `durable-delivery/` keys that no live row owns. This removes a family of storage keys and fixes 11.

**F. Make `DurableDeliveryProcessor` private.**

- Only the subscriptions facet uses it. The facet builds a fake `ProcessEventArgs` (`sdf:302-312`) and never runs a `ProcessorEngine`.
- The `StreamProcessor` base, the zod contract, `drive()` and `#args` exist only for that pretence and for the unit tests.
- Move it into apps/os as a plain class with `push(offsets)`/`wake()`, which shrinks `iterate/stream/*`.
- Processor authoring, the React hooks and the plain Cap'n Web client are unaffected.
- First check the package exports map for anything outside apps/os importing `iterate/stream/durable-delivery`.

**G. (Optional) Drop the offsets list from ordered cursors.**

- For a fixed `configuredAtOffset` and range, the set of selected events can't change: durable events never change, and `consumes` is part of the row's identity.
- So the check at `ctx:963-967` can only fire if part of the log is lost, and the range checks already catch that.
- Keep the offsets for fan-out items.

## Release direction

1. **Land the small fixes first:**
   - defect 1 (one branch);
   - defect 3 (delete a condition);
   - defect 6 (delete the `return`);
   - skip pushes that carry nothing;
   - busy backoff, or B.
2. **Then do the simplification: A, B, D, E and F.** Together they remove the facet's body budget, the settlement cache and the stored high-water, and the push stops carrying bodies. Nothing `subscribe` can express today is lost.

## Tests and telemetry to add

**Unit tests** (`durable-delivery.test.ts`):

- Fan-out with one event in backoff and a page that isn't at the head still reads the next page without a push.
- A lower-offset ephemeral is delivered before a later durable range.
- A `deliver` that never answers doesn't produce a fixed 1 s wake cadence.
- Resume on a running ordered row behaves as you decide it should.

**Workers tests:**

- An ordered page of two ~4 MiB ASCII events is delivered exactly once.
- A late success after more than 40 s of backoff gives exactly one invoke.
- A release arriving after a commit's claim, followed by a context abort, still delivers on the alarm.
- A freshly started facet under concurrent commits applies configuration on its first push.
- Replacing a row after a facet restart leaves no old cursor keys.
- A late claim after `deleteFirstPartyFacet` doesn't recreate the facet.
- A chain of durable rows across three contexts stays within the subrequest depth limit.

**Telemetry:**

- Consecutive busy answers per row, and how long they've lasted.
- Count of `body-budget-exhausted` (the warning already exists).
- Waits on in-flight calls (or cache hits) versus evictions.
- Ephemeral drops by reason: budget, not in ring, stale resume.
- Alarm passes whose only due item is the subscriptions claim.
- How often pushes are skipped.
- Facet reads whose `afterOffset` is past `highestDurableOffset()`.

---

I only read source. I ran no commands and no tests, unit or Workers.
