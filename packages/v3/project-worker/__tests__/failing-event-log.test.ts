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
  itx.invokeCapability(["itx", ["append", ...events]]);

const read = (
  itx: any,
  afterOffset?: number,
  limit?: number,
): Promise<{ events: any[]; scannedThroughOffset: number }> =>
  itx.invokeCapability([
    "itx",
    [
      "read",
      ...(afterOffset === undefined
        ? []
        : limit === undefined
          ? [afterOffset]
          : [afterOffset, limit]),
    ],
  ]);

const coreState = async (itx: any) =>
  (await itx.invokeCapability("itx.facets.get('core').snapshot()")).state;

const breakerConfigured = (capacity: number, refillPerSecond: number) => ({
  type: "events.iterate.com/stream/breaker-configured",
  payload: { capacity, refillPerSecond },
});

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

test("an in-batch idempotency dedupe hit is reduced ONCE, not twice", async () => {
  // FIXED: StreamEventLog.append pushed a dedupe hit into `committed` carrying the offset of the
  //   row it matched; when that row was inserted EARLIER IN THE SAME BATCH (a retry beside its
  //   original), the offset is > scannedAfterOffset, so the `e.offset <= scannedAfterOffset` skip
  //   in #reduceInlineAtCommit did not fire and the ONE durable event was reduced TWICE through
  //   every inline processor (double breaker spend, double capability-table apply, double facet
  //   delivery). append now derives a per-offset `distinct` view (first-wins) that feeds the inline
  //   reduce AND the facet-drive / connected delivery, so each durable event is processed ONCE —
  //   while the returned `committed` keeps one receipt per input. One durable event = one reduce =
  //   one token spent, and the inline checkpoint rebuilds bit-identically from the log again.
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

test("an idempotent retry dedupes even when the breaker bucket is empty", async () => {
  // FIXED: append's breaker gate counted every non-ephemeral input as durable growth BEFORE the
  //   commit point could dedupe it — a retry of an already-committed idempotencyKey was refused with
  //   STREAM_BREAKER_OPEN even though committing it writes zero rows and spends zero tokens. On the
  //   about-to-trip path the gate now re-counts excluding inputs whose idempotencyKey is already
  //   committed (StreamEventLog.hasIdempotencyKey), so the reconciling retry dedupes instead of
  //   tripping — the breaker meters DURABLE LOG GROWTH, and a dedupe hit grows nothing. (Retry
  //   storms are exactly when idempotency keys and a tight breaker coincide.)
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
  await append(itx, { type: "mark", payload: { n: 1 } }, { type: "mark", payload: { n: 2 } });
  // The TRUE head comes from a short-page read (platform events — woken, live-state deltas —
  // consume offsets beyond the last receipt, so a receipt offset under-approximates it).
  const head = (await read(itx)).scannedThroughOffset;
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
  // No orphaned rows above the recorded max offset (platform events — woken — share the log,
  // so assert presence/absence, not the exact row list)…
  const page = await read(itx);
  const types = page.events.map((e) => e.type);
  expect(types).toContain("seed");
  expect(types).not.toContain("fresh-before");
  expect(types).not.toContain("fresh-after");
  expect(seed.offset).toBeGreaterThan(0);
  // …and no orphaned OFFSETS either: the next append lands exactly one past the pre-rollback
  // head (a leaked max-offset would open a gap; a leaked row would collide on the primary key).
  const [probe] = await append(itx, { type: "probe", payload: {} });
  expect(probe.offset).toBe(page.scannedThroughOffset + 1);
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
  expect(batch[2].offset).toBe(batch[0].offset + 1); // the hit did not burn an offset in between
  const page = await read(itx);
  const offsets = page.events.map((e) => e.offset);
  expect(new Set(offsets).size).toBe(offsets.length); // no offset assigned twice
  // the original and both fresh events are each in the log exactly once
  expect(offsets).toEqual(expect.arrayContaining([orig.offset, batch[0].offset, batch[2].offset]));
  expect(page.events.filter((e) => e.idempotencyKey === "kd")).toHaveLength(1);
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
  // and the log agrees: exactly 20 race rows, offsets unique and matching the receipts
  // (platform events — woken, live-state deltas — share the sequence, so the race offsets
  // need not be 1..20; uniqueness and receipt/log agreement are the property)
  const page = await read(a);
  const raceOffsets = page.events.filter((e) => e.type === "race").map((e) => e.offset);
  expect(raceOffsets).toHaveLength(20);
  expect([...raceOffsets].sort((x, y) => x - y)).toEqual([...offsets].sort((x, y) => x - y));
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
  await new Promise((r) => setTimeout(r, 2100));
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
  const { providedAtOffset } = await itx.provide("itx.hello", "itx.whoami");
  expect(providedAtOffset).toBeGreaterThan(0);
  const who = await itx.invokeCapability(["itx", ["hello"]]);
  expect(who).toMatchObject({ projectId: "prj_table_badmount" });
  // and the malformed mount is dead weight, not a route (default-deny still answers there)
  const missErr = await rejection(itx.invokeCapability(["itx", ["broken"]]));
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
  // the fresh insert before the contradiction rolled back with it (assert presence/absence —
  // platform events like woken share the log)
  const page = await read(itx);
  const types = page.events.map((e) => e.type);
  expect(types).toContain("seed");
  expect(types).not.toContain("fresh");
  expect(seed.offset).toBeGreaterThan(0);
  // dense continuation from the pre-rollback head — the refused batch burned no offsets
  const [probe] = await append(itx, { type: "probe", payload: {} });
  expect(probe.offset).toBe(page.scannedThroughOffset + 1);
});

test("breaker overdraft: an admitted batch drives tokens NEGATIVE, and the debt is CARRIED, not clamped", async () => {
  // DECIDED CONTRACT — carry the debt. Admission reads PRE-batch state, so a batch that carries
  // its own breaker-configured event is admitted while the breaker is still off; the reduce then
  // debits every durable event unconditionally (capacity 2, then d1..d4 → tokens -2). Clamping at
  // zero would forgive the overdraft the moment it happened; carrying it means refill must climb
  // THROUGH the debt before the stream takes durable writes again — overshoot on the way in is
  // paid back, second for second, on the way out.
  const itx = await harness.itx("prj_core_overdraft");
  const batch = await append(
    itx,
    breakerConfigured(2, 1), // 1 token/second — recovery below rides wall time
    { type: "d", payload: { n: 1 } },
    { type: "d", payload: { n: 2 } },
    { type: "d", payload: { n: 3 } },
    { type: "d", payload: { n: 4 } },
  );
  expect(batch).toHaveLength(5); // the whole batch passed the (pre-batch, breaker-off) gate
  const committedAtMs = Date.now(); // the debt clock starts at the batch's event times
  expect((await coreState(itx)).breaker.tokens).toBeCloseTo(-2, 1); // the overdraft, on the record
  // the very next durable append trips…
  const err = await rejection(append(itx, { type: "d", payload: { n: 5 } }));
  expect(err.message).toContain("circuit breaker open");
  // …and STAYS tripped past a full refill period: a clamp-at-zero bucket would hold ~1.2 tokens
  // by now; a bucket at -2 has only climbed to ~-0.8. (Refusals commit nothing — no state moves.)
  await new Promise((r) => setTimeout(r, 1200));
  const still = await rejection(append(itx, { type: "d", payload: { n: 6 } }));
  expect(still.message).toContain("circuit breaker open");
  // once wall time covers the debt PLUS one token (3s at 1/s; sleep the remainder with margin),
  // the stream takes durable writes again.
  await new Promise((r) => setTimeout(r, Math.max(0, committedAtMs + 3500 - Date.now())));
  const [freed] = await append(itx, { type: "d", payload: { n: 7 } });
  expect(freed.offset).toBeGreaterThan(0);
});
