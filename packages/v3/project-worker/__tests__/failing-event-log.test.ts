// __tests__/failing-event-log.test.ts — BUG HUNT over the event log + inline core (the
// StreamEventLog commit point in stream-durable-object.ts and the CoreStreamProcessor
// pause/breaker reduce). Every test asserts the CORRECT behavior; a test marked `test.fails`
// documents a genuine bug in the current code (its body opens with BUG/EXPECTED/ACTUAL/WHY).
// Tests that pass are regression locks on edge cases the hunt cleared. One boot per file;
// every test owns a unique ctx (state persists across tests inside one workerd boot).

import { afterAll, beforeAll, expect, test } from "vitest";
import { startProjectHarness, type ProjectHarness } from "./harness.ts";

let harness: ProjectHarness;
beforeAll(async () => {
  harness = await startProjectHarness();
}, 120_000);
afterAll(async () => {
  await harness?.stop();
});

// ── tiny verbs over the real client surface (no framework — the smoke test's voice) ──

const append = (itx: any, ...events: unknown[]): Promise<any[]> =>
  itx.invokeCapability({ path: ["stream", "append"], args: events });

const read = (
  itx: any,
  afterOffset?: number,
  limit?: number,
): Promise<{ events: any[]; scannedThroughOffset: number }> =>
  itx.invokeCapability({
    path: ["stream", "read"],
    args:
      afterOffset === undefined ? [] : limit === undefined ? [afterOffset] : [afterOffset, limit],
  });

const coreState = async (itx: any) => (await itx.facetSnapshot("core")).state;

const breakerConfigured = (capacity: number, refillPerSecond: number) => ({
  type: "events.iterate.com/stream/breaker-configured",
  payload: { capacity, refillPerSecond },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Await a promise that MUST reject; hand back the error for inspection. */
async function rejection(p: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await p;
  } catch (e) {
    return e as Error & { code?: string };
  }
  throw new Error("expected the call to reject — it fulfilled");
}

// ── confirmed bugs (test.fails: the CORRECT assertion, failing against current code) ──

test.fails("an in-batch idempotency dedupe hit is reduced ONCE, not twice", async () => {
  // BUG: StreamEventLog.append pushes a dedupe hit into `committed` carrying the offset of the
  //   row it matched. When the matched row was inserted EARLIER IN THE SAME BATCH (a retry
  //   landing beside its original), that offset is > scannedAfterOffset — so the
  //   `e.offset <= scannedAfterOffset` skip in #reduceInlineAtCommit does not fire and the ONE
  //   durable event is reduced TWICE through every inline processor.
  // EXPECTED: one durable event = one reduce = one breaker token spent (tokens ≈ capacity − 1).
  // ACTUAL: the core reduce spends TWO tokens (tokens ≈ capacity − 2); the same double-apply
  //   hits the capability table, and the facet drives deliver the event twice in one batch.
  // WHY IT MATTERS: the inline checkpoint no longer rebuilds bit-identically from the log — a
  //   replay after eviction reduces the row ONCE (one row in SQLite), so checkpointed state and
  //   rebuilt state diverge, which is the exact invariant inline hosting is built on.
  const itx = await harness.itx("prj_bug_dupbatch");
  await append(itx, breakerConfigured(10, 0.000001));
  const pair = await append(
    itx,
    { type: "mark", payload: { n: 1 }, idempotencyKey: "dup-in-batch" },
    { type: "mark", payload: { n: 1 }, idempotencyKey: "dup-in-batch" },
  );
  // The dedupe itself is right: both entries answer with the ONE committed offset…
  expect(pair).toHaveLength(2);
  expect(pair[1].offset).toBe(pair[0].offset);
  const page = await read(itx);
  expect(page.events.filter((e) => e.idempotencyKey === "dup-in-batch")).toHaveLength(1);
  // …but the commit-point reduce must have spent exactly ONE token for it.
  const state = await coreState(itx);
  expect(state.breaker.tokens).toBeCloseTo(9, 1);
});

test.fails("an idempotent retry dedupes even when the breaker bucket is empty", async () => {
  // BUG: append's breaker enforcement counts every non-ephemeral input as durable growth
  //   (`counted = nonControl.filter(i => !i.ephemeral).length`) BEFORE the commit point gets to
  //   dedupe it — a retry of an already-committed idempotencyKey is refused with
  //   STREAM_BREAKER_OPEN even though committing it would write zero rows and spend zero tokens.
  // EXPECTED: the retry dedupes (returns the original committed event, same offset) — the
  //   breaker meters DURABLE LOG GROWTH (its own doc) and a dedupe hit grows nothing.
  // ACTUAL: STREAM_BREAKER_OPEN.
  // WHY IT MATTERS: idempotency keys exist exactly for retry storms; a tight breaker is exactly
  //   when retries happen. Refusing the reconciling retry turns at-least-once delivery into
  //   cannot-confirm-delivery right when the stream is under pressure.
  const itx = await harness.itx("prj_bug_retrybreaker");
  await append(itx, breakerConfigured(3, 0.000001));
  const [orig] = await append(itx, {
    type: "job",
    payload: { id: "a" },
    idempotencyKey: "retry-me",
  });
  await append(itx, { type: "job", payload: { id: "b" } }, { type: "job", payload: { id: "c" } });
  // Sanity: the bucket really is empty for FRESH durable events…
  const freshErr = await rejection(append(itx, { type: "job", payload: { id: "d" } }));
  expect(freshErr.message).toContain("circuit breaker open");
  // …but the idempotent RETRY adds zero durable growth and must dedupe, not trip.
  const [replay] = await append(itx, {
    type: "job",
    payload: { id: "a" },
    idempotencyKey: "retry-me",
  });
  expect(replay.offset).toBe(orig.offset);
});

// FIXED (defect 8): CoreStreamProcessor.reduce defaults `event.payload ?? {}`.
test("a bare stream/paused event (no payload) actually pauses the stream", async () => {
  // BUG: CoreStreamProcessor.reduce destructures `event.payload` without a fallback
  //   (`const { reason } = event.payload as {…}`). An append of `{ type: …/stream/paused }`
  //   with NO payload — which the input schema allows and the contract's payloadSchema defaults
  //   (reason: "paused") — throws TypeError inside the reduce, which #reduceInline catches and
  //   SKIPS. The pause event commits durably yet pauses nothing.
  // EXPECTED: the stream is paused (reason defaulting to "paused"); the next non-control
  //   append is refused with STREAM_PAUSED.
  // ACTUAL: the reduce throws on the undefined destructure, the event is skipped, and the next
  //   append sails through.
  // WHY IT MATTERS: a pause that silently doesn't pause is an operator trap — the control fact
  //   is in the log (auditable, replayable, and it will re-throw identically on every replay)
  //   while the stream keeps accepting writes the operator believes are refused.
  const itx = await harness.itx("prj_bug_barepause");
  await append(itx, { type: "events.iterate.com/stream/paused" });
  const err = await rejection(append(itx, { type: "mark", payload: { n: 1 } }));
  expect(err.message).toContain("stream paused");
});

// FIXED (defect 8): payload defaulted; the documented empty-payload off-switch works.
test("a bare breaker-configured event (no payload) turns the breaker off", async () => {
  // BUG: same undefined-destructure as the pause reduce — `const { capacity, refillPerSecond }
  //   = event.payload as {…}` throws when the payload is omitted entirely, so the documented
  //   off-switch ("an empty payload turns it off" — core-processor.ts) silently no-ops. Only
  //   the `payload: {}` spelling works.
  // EXPECTED: breaker state is null after the bare event; a durable append passes again.
  // ACTUAL: the reduce throws, the event is skipped, the breaker stays configured, and the
  //   next durable append is refused STREAM_BREAKER_OPEN.
  // WHY IT MATTERS: the breaker-off control is the recovery path for a tripped stream; the
  //   spelling difference between `{}` and absent payload deciding whether recovery happens is
  //   exactly the kind of silent skew the event-sourced core exists to prevent.
  const itx = await harness.itx("prj_bug_barebreakeroff");
  await append(itx, breakerConfigured(1, 0.000001));
  await append(itx, { type: "spend", payload: { n: 1 } }); // bucket → 0
  await append(itx, { type: "events.iterate.com/stream/breaker-configured" }); // documented off-switch
  expect((await coreState(itx)).breaker).toBeNull();
  const [after] = await append(itx, { type: "spend", payload: { n: 2 } });
  expect(after.offset).toBeGreaterThan(0);
});

test("read(afterOffset beyond head) never claims a scan of unassigned offsets", async () => {
  // BUG: read's short-page arm computes `Math.max(afterOffset, highestAssignedOffset())` — for
  //   an afterOffset BEYOND the head it answers scannedThroughOffset = afterOffset, a "proof"
  //   of having scanned offsets nobody has assigned yet (the virgin-table branch has the same
  //   shape: it echoes afterOffset with head 0).
  // EXPECTED: scannedThroughOffset ≤ the highest offset ever assigned — a scanned range can
  //   only cover offsets that exist.
  // ACTUAL: scannedThroughOffset === afterOffset (head + 100 here).
  // WHY IT MATTERS: scanned ranges are the contiguity currency of every consumer (facet
  //   cursors, subscription healing, resumeSubscription's operator seek). A cursor seeded from
  //   this answer sits beyond head and every event later assigned in (head, afterOffset] is
  //   silently skipped forever — offset-keyed data loss from one overshooting read.
  const itx = await harness.itx("prj_bug_readbeyond");
  const committed = await append(
    itx,
    { type: "mark", payload: { n: 1 } },
    { type: "mark", payload: { n: 2 } },
  );
  const head = committed[1].offset;
  const page = await read(itx, head + 100);
  expect(page.events).toEqual([]);
  expect(page.scannedThroughOffset).toBeLessThanOrEqual(head);
});

// ── edge cases the hunt cleared (passing regression locks) ──

test("a mid-batch idempotency conflict rolls the whole batch back atomically", async () => {
  const itx = await harness.itx("prj_log_rollback");
  const [seed] = await append(itx, { type: "seed", payload: { v: 1 }, idempotencyKey: "kc" });
  // fresh insert, THEN the conflict (same key, different body), then more fresh — the earlier
  // insert must not survive the throw (transactionSync rolls sql + kv together).
  const err = await rejection(
    append(
      itx,
      { type: "fresh-before", payload: { n: 1 } },
      { type: "seed", payload: { v: 2 }, idempotencyKey: "kc" },
      { type: "fresh-after", payload: { n: 2 } },
    ),
  );
  expect(err.message).toContain('idempotency key "kc" already names a different event');
  // No orphaned rows above the recorded max offset…
  const page = await read(itx);
  expect(page.events.map((e) => e.type)).toEqual(["seed"]);
  // …and no orphaned OFFSETS either: the next append lands exactly at seed.offset + 1
  // (a leaked max-offset would open a gap; a leaked row would collide on the primary key).
  const [probe] = await append(itx, { type: "probe", payload: {} });
  expect(probe.offset).toBe(seed.offset + 1);
});

test("a dedupe hit interleaved with fresh events assigns no double offsets", async () => {
  const itx = await harness.itx("prj_log_dedupemix");
  const [orig] = await append(itx, { type: "note", payload: { v: 1 }, idempotencyKey: "kd" });
  const batch = await append(
    itx,
    { type: "fresh", payload: { n: 1 } },
    { type: "note", payload: { v: 1 }, idempotencyKey: "kd" }, // dedupe hit — consumes NO offset
    { type: "fresh", payload: { n: 2 } },
  );
  expect(batch[1].offset).toBe(orig.offset); // the hit answers with the ORIGINAL identity
  expect(batch[0].offset).toBe(orig.offset + 1);
  expect(batch[2].offset).toBe(orig.offset + 2); // the hit did not burn an offset in between
  const page = await read(itx);
  const offsets = page.events.map((e) => e.offset);
  expect(offsets).toEqual([orig.offset, orig.offset + 1, orig.offset + 2]);
  expect(new Set(offsets).size).toBe(offsets.length);
});

test("concurrent appends from two sessions to one ctx keep offsets unique", async () => {
  const a = await harness.itx("prj_log_concurrent");
  const b = await harness.itx("prj_log_concurrent"); // same ctx, second live session
  const results = await Promise.all([
    ...Array.from({ length: 10 }, (_, i) => append(a, { type: "race", payload: { from: "a", i } })),
    ...Array.from({ length: 10 }, (_, i) => append(b, { type: "race", payload: { from: "b", i } })),
  ]);
  const offsets = results.map(([e]) => e.offset);
  expect(new Set(offsets).size).toBe(20);
  // and the log agrees: 20 rows, offsets 1..20 with no gap and no reuse
  const page = await read(a);
  expect(page.events.map((e) => e.offset).sort((x, y) => x - y)).toEqual(
    Array.from({ length: 20 }, (_, i) => i + 1),
  );
});

test("pause refuses durable AND ephemeral appends, mixed batches wholesale — control passes", async () => {
  const itx = await harness.itx("prj_core_pause");
  await append(itx, {
    type: "events.iterate.com/stream/paused",
    payload: { reason: "maintenance" },
  });
  // durable → refused, with the reason on the message
  const durableErr = await rejection(append(itx, { type: "mark", payload: { n: 1 } }));
  expect(durableErr.message).toContain("stream paused: maintenance");
  // ephemerals are non-control — refused too (a paused stream is paused for everything)
  const ephErr = await rejection(append(itx, { type: "blip", payload: {}, ephemeral: true }));
  expect(ephErr.message).toContain("stream paused");
  // a batch MIXING the resume with a non-control event is refused WHOLESALE (enforcement is
  // batch-atomic at the door — no partial admission)
  const mixedErr = await rejection(
    append(
      itx,
      { type: "events.iterate.com/stream/resumed", payload: {} },
      { type: "mark", payload: { n: 2 } },
    ),
  );
  expect(mixedErr.message).toContain("stream paused");
  // the bare resume passes — a paused stream must always accept its own resume
  await append(itx, { type: "events.iterate.com/stream/resumed", payload: {} });
  const [after] = await append(itx, { type: "mark", payload: { resumed: true } });
  expect(after.offset).toBeGreaterThan(0);
});

test("breaker boundary: remaining === counted passes, empty bucket refuses durable but never ephemeral-only", async () => {
  const itx = await harness.itx("prj_core_boundary");
  await append(itx, breakerConfigured(2, 0.000001));
  // EXACTLY remaining === counted passes (the check is strict <)
  const two = await append(
    itx,
    { type: "spend", payload: { n: 1 } },
    { type: "spend", payload: { n: 2 } },
  );
  expect(two).toHaveLength(2);
  // bucket now empty: one more durable is refused
  const err = await rejection(append(itx, { type: "spend", payload: { n: 3 } }));
  expect(err.message).toContain("circuit breaker open");
  // counted=0 always passes: an ephemeral-only batch sails through the empty bucket…
  const eph = await append(
    itx,
    { type: "blip", payload: { i: 1 }, ephemeral: true },
    { type: "blip", payload: { i: 2 }, ephemeral: true },
  );
  expect(eph).toHaveLength(2);
  expect(eph[1].offset).toBe(eph[0].offset + 1); // …still consuming real offsets
  // a MIXED batch counts only its durable half — and that half is refused
  const mixedErr = await rejection(
    append(
      itx,
      { type: "blip", payload: {}, ephemeral: true },
      { type: "spend", payload: { n: 4 } },
    ),
  );
  expect(mixedErr.message).toContain("1 durable event(s) exceed the bucket");
  // the `payload: {}` off-switch DOES work (contrast: the bare no-payload bug above)
  await append(itx, { type: "events.iterate.com/stream/breaker-configured", payload: {} });
  expect((await coreState(itx)).breaker).toBeNull();
  const [freed] = await append(itx, { type: "spend", payload: { n: 5 } });
  expect(freed.offset).toBeGreaterThan(0);
});

test("breaker refills across a paused period and clamps at capacity", async () => {
  const itx = await harness.itx("prj_core_pausedrefill");
  await append(itx, breakerConfigured(1, 1)); // capacity 1, one token per second
  await append(itx, { type: "spend", payload: { n: 1 } }); // bucket → 0
  const err = await rejection(append(itx, { type: "spend", payload: { n: 2 } }));
  expect(err.message).toContain("circuit breaker open");
  // pause does not freeze the bucket: refill rides elapsed time, not append traffic
  await append(itx, { type: "events.iterate.com/stream/paused", payload: { reason: "soak" } });
  await sleep(2100);
  await append(itx, { type: "events.iterate.com/stream/resumed", payload: {} });
  const [after] = await append(itx, { type: "spend", payload: { n: 3 } });
  expect(after.offset).toBeGreaterThan(0);
  // 2.1s at 1/s would be 2.1 tokens UNclamped — the capacity clamp means the spend above
  // emptied the bucket again, so an immediate second durable append is refused.
  const err2 = await rejection(append(itx, { type: "spend", payload: { n: 4 } }));
  expect(err2.message).toContain("circuit breaker open");
});

test("read paging: a full page stops at its last row; a short page proves the head through ephemeral holes", async () => {
  const itx = await harness.itx("prj_log_paging");
  const durables = await append(
    itx,
    { type: "d", payload: { n: 1 } },
    { type: "d", payload: { n: 2 } },
    { type: "d", payload: { n: 3 } },
  );
  const eph = await append(
    itx,
    { type: "e", payload: {}, ephemeral: true },
    { type: "e", payload: {}, ephemeral: true },
  );
  const base = durables[0].offset - 1;
  // FULL page (events.length === limit): only contiguously known through its LAST ROW —
  // scannedThroughOffset must not overshoot past the ephemeral holes to the head
  const full = await read(itx, base, 3);
  expect(full.events).toHaveLength(3);
  expect(full.scannedThroughOffset).toBe(durables[2].offset);
  // SHORT page from there: proves the scan reached the head, ephemeral offsets included
  const short = await read(itx, durables[2].offset, 3);
  expect(short.events).toHaveLength(0);
  expect(short.scannedThroughOffset).toBe(eph[1].offset);
  // one more durable AFTER the holes: a full page whose last row IS the head lands exactly on it
  const [d4] = await append(itx, { type: "d", payload: { n: 4 } });
  const exact = await read(itx, base, 4);
  expect(exact.events).toHaveLength(4);
  expect(exact.scannedThroughOffset).toBe(d4.offset);
  // and a default-limit read across the holes returns just the row beyond them
  const across = await read(itx, durables[2].offset);
  expect(across.events.map((e) => e.offset)).toEqual([d4.offset]);
  expect(across.scannedThroughOffset).toBe(d4.offset);
});

test("bad mount events are skipped without wedging later provides", async () => {
  const itx = await harness.itx("prj_table_badmount");
  // an unparseable target — the reduce's own try/catch lane
  await append(itx, {
    type: "events.iterate.com/capability-table/capability-provided",
    payload: { path: "itx.broken", target: "((((" },
  });
  // NO payload at all — the destructure lane (caught by the per-event reduce guard)
  await append(itx, { type: "events.iterate.com/capability-table/capability-provided" });
  // wrong shapes inside the payload
  await append(itx, {
    type: "events.iterate.com/capability-table/capability-provided",
    payload: { path: 42, target: ["not", "a", "string"] },
  });
  // the table still takes provides and resolves them — the checkpoint didn't wedge
  const { providedAtOffset } = await itx.provide({ path: "itx.hello", target: "itx.whoami" });
  expect(providedAtOffset).toBeGreaterThan(0);
  const who = await itx.invokeCapability({ path: ["hello"], args: [] });
  expect(who).toMatchObject({ projectId: "prj_table_badmount" });
  // and the malformed mount is dead weight, not a route (default-deny still answers there)
  const missErr = await rejection(itx.invokeCapability({ path: ["broken"], args: [] }));
  expect(missErr.message).toContain("no capability matches");
});

test("ephemeral + idempotencyKey is refused loudly and atomically mid-batch", async () => {
  const itx = await harness.itx("prj_log_ephkey");
  const [seed] = await append(itx, { type: "seed", payload: {} });
  const err = await rejection(
    append(
      itx,
      { type: "fresh", payload: { n: 1 } },
      { type: "blip", payload: {}, ephemeral: true, idempotencyKey: "contradiction" },
    ),
  );
  expect(err.message).toContain("ephemeral events cannot carry an idempotencyKey");
  // the fresh insert before the contradiction rolled back with it
  const page = await read(itx);
  expect(page.events.map((e) => e.type)).toEqual(["seed"]);
  const [probe] = await append(itx, { type: "probe", payload: {} });
  expect(probe.offset).toBe(seed.offset + 1);
});

// ── speculative / unverifiable here ──

test.todo(
  "breaker overdraft: a batch admitted before its own breaker-configured event (enforcement reads pre-batch state) can drive tokens NEGATIVE — clamp-at-zero vs carry-the-debt is an undecided contract",
);
test.todo(
  "the in-batch dedupe double-reduce also skews the checkpoint away from a log replay — observable only across an eviction/rebuild, which this harness cannot force",
);
test.todo(
  "a facet drive redelivers a dedupe-hit event with an offset below the batch's claimed scannedAfterOffset — whether facet cursors tolerate the out-of-range member needs a facet-processor fixture",
);
