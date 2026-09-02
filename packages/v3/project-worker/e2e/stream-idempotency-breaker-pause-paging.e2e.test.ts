// stream-idempotency-breaker-pause-paging.e2e.test.ts — the event log's COMMIT POINT and the inline
// reduces that sit at it (`Stream.append` in stream/stream.ts, the core
// reduce's pause/breaker), end to end through `itx.append`/`itx.read`. Proves: the append door's
// runtime guards (a non-string type, a non-literal-true `ephemeral`, ephemeral + idempotencyKey);
// idempotency dedupe at the commit point (an in-batch hit reduced ONCE, a retry deduping through an
// empty breaker bucket, a mid-batch conflict rolling the whole batch back, a hit burning no offset);
// deep payloads near the codec's depth budget; the bare (payload-less) control events; pause and
// breaker enforcement (wholesale, ephemerals never counted, debt carried, refill by wall time); and
// read paging's scanned-offset-range proof (never past the durable mark, never beyond head).

import { expect, test } from "vitest";
import { append, freshCtx, openItx, readAll, rejection } from "./support/client.ts";

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

// ── the append door's runtime guards ──

test("the runtime guards reject a non-string or blank type AND a non-literal-true ephemeral, committing nothing", async () => {
  // There is no TS-type allow-list on the RPC boundary; what remains are the explicit runtime
  // guards in IterateContextDurableObject.append — the SOLE enforcement.
  const itx = openItx(freshCtx("guards"));
  expect((await rejection(append(itx, { type: 12345 }))).message).toMatch(/non-empty type/i);
  expect((await rejection(append(itx, { type: "" }))).message).toMatch(/non-empty type/i);
  expect((await rejection(append(itx, { type: "   " }))).message).toMatch(/non-empty type/i);
  // `ephemeral: false` is a loud input error, not a silent synonym for omitting the flag
  expect((await rejection(append(itx, { type: "sneaky", ephemeral: false }))).message).toMatch(
    /ephemeral must be literal true or absent/i,
  );
  expect((await readAll(itx)).map((e) => e.type)).not.toContain("sneaky"); // nothing committed
});

test("ephemeral + idempotencyKey is refused loudly and atomically mid-batch", async () => {
  const itx = openItx(freshCtx("ephkey"));
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
  const types = (await readAll(itx)).map((e) => e.type);
  expect(types).toContain("seed");
  expect(types).not.toContain("fresh");
  expect(seed.offset).toBeGreaterThan(0);
  // dense continuation — a refused batch burns no offsets: a marker before a second refusal and a
  // probe after it land adjacent (a plain event changes no inline state; nothing ephemeral lands between)
  const [marker] = await append(itx, { type: "marker", payload: {} });
  await rejection(
    append(itx, { type: "blip", payload: {}, ephemeral: true, idempotencyKey: "contradiction" }),
  );
  const [probe] = await append(itx, { type: "probe", payload: {} });
  expect(probe.offset).toBe(marker.offset + 1);
});

// ── idempotency at the commit point ──

test("an in-batch idempotency dedupe hit is reduced ONCE, not twice", async () => {
  // append derives a per-offset `distinct` view (first-wins) that feeds the inline reduce AND the
  // delivery, so each durable event is processed ONCE — while the returned `committed` keeps one
  // receipt per input. One durable event = one reduce = one token spent.
  const itx = openItx(freshCtx("dupbatch"));
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
  // …and the commit-point reduce spent exactly ONE token for it.
  expect((await coreState(itx)).breaker.tokens).toBeCloseTo(9, 1);
});

test("an idempotent retry dedupes even when the breaker bucket is empty", async () => {
  // The breaker meters DURABLE LOG GROWTH, and a dedupe hit grows nothing: on the about-to-trip path
  // the gate re-counts excluding inputs whose idempotencyKey is already committed. (Retry storms are
  // exactly when idempotency keys and a tight breaker coincide.)
  const itx = openItx(freshCtx("retrybreaker"));
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

test("a mid-batch idempotency conflict rolls the whole batch back atomically", async () => {
  const itx = openItx(freshCtx("rollback"));
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
  const types = (await readAll(itx)).map((e) => e.type);
  expect(types).toContain("seed");
  expect(types).not.toContain("fresh-before");
  expect(types).not.toContain("fresh-after");
  expect(seed.offset).toBeGreaterThan(0);
  // …and no orphaned OFFSETS either: a marker right before a second refused batch and a probe
  // right after land adjacent (a leaked max-offset would open a gap; a leaked row would collide on
  // the primary key). A plain event changes no inline state, so nothing ephemeral lands between.
  const [marker] = await append(itx, { type: "marker", payload: {} });
  await rejection(
    append(itx, { type: "fresh-again" }, { type: "seed", payload: { v: 3 }, idempotencyKey: "kc" }),
  );
  const [probe] = await append(itx, { type: "probe", payload: {} });
  expect(probe.offset).toBe(marker.offset + 1);
});

test("a dedupe hit interleaved with fresh events assigns no double offsets", async () => {
  const itx = openItx(freshCtx("dedupemix"));
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
  const ctx = freshCtx("concurrent");
  const a = openItx(ctx);
  const b = openItx(ctx); // same ctx, second live session
  const results = await Promise.all([
    ...Array.from({ length: 10 }, (_, i) => append(a, { type: "race", payload: { from: "a", i } })),
    ...Array.from({ length: 10 }, (_, i) => append(b, { type: "race", payload: { from: "b", i } })),
  ]);
  const offsets = results.map(([e]) => e.offset);
  expect(new Set(offsets).size).toBe(20);
  // and the log agrees: exactly 20 race rows, offsets unique and matching the receipts
  // (platform events — woken, live-state deltas — share the sequence, so the race offsets
  // need not be 1..20; uniqueness and receipt/log agreement are the property)
  const raceOffsets = (await readAll(a)).filter((e) => e.type === "race").map((e) => e.offset);
  expect(raceOffsets).toHaveLength(20);
  expect([...raceOffsets].sort((x, y) => x - y)).toEqual([...offsets].sort((x, y) => x - y));
});

// ── expression/value depth near the codec's parse budget ──

/** n-deep nested array with a 0 at the bottom: [[[…0…]]]. */
const nested = (n: number): unknown => {
  let v: unknown = 0;
  for (let i = 0; i < n; i++) v = [v];
  return v;
};
/** The same shape in the STRING half of the codec. */
const nestedLiteral = (n: number): string => "[".repeat(n) + "0" + "]".repeat(n);

test("a 64-deep nested-array payload (structured lane) appends and reads back byte-identically", async () => {
  const itx = openItx(freshCtx("depth"));
  const payload = { d: nested(64) }; // the value-depth budget is 64 — this is AT the edge
  const [committed] = await append(itx, { type: "deep", payload });
  expect(committed.offset).toBeGreaterThanOrEqual(1);
  const page = await read(itx, committed.offset - 1, 1);
  expect(page.events).toHaveLength(1);
  expect(JSON.stringify(page.events[0].payload)).toBe(JSON.stringify(payload));
});

test("string-half expressions: deeply nested payloads parse and round-trip (JSON5, no parse budget)", async () => {
  const itx = openItx(freshCtx("depthstr"));
  // JSON5 is iterative — there is no artificial parse budget; a deep arg parses and round-trips.
  for (const depth of [58, 70]) {
    const [committed] = await itx.invokeCapability(
      `itx.append({type:'deepstr',payload:{d:${nestedLiteral(depth)}}})`,
    );
    const page = await read(itx, committed.offset - 1, 1);
    expect(JSON.stringify(page.events[0].payload)).toBe(JSON.stringify({ d: nested(depth) }));
  }
});

test("an idempotent RETRY of a 64-deep payload dedupes instead of tripping the depth guard", async () => {
  // Idempotency keys are the crash-recovery story; a payload near the depth budget must not turn
  // the retry the key exists to make safe into the one call that fails.
  const itx = openItx(freshCtx("depthkey"));
  const build = () => ({
    type: "deep-keyed",
    payload: { d: nested(64) },
    idempotencyKey: "deep-once",
  });
  const [first] = await append(itx, build());
  const [retry] = await append(itx, build());
  expect(retry.offset).toBe(first.offset); // same key + same body = same event
});

// ── the core reduce: pause + breaker (control is ordinary events; enforcement reads the fold) ──

test("a bare stream/paused event (no payload) actually pauses the stream", async () => {
  // CoreStreamProcessor.reduce defaults `event.payload ?? {}` — a pause that silently doesn't pause
  // would be an operator trap (the control fact is in the log while writes keep landing).
  const itx = openItx(freshCtx("barepause"));
  await append(itx, { type: "events.iterate.com/stream/paused" });
  const err = await rejection(append(itx, { type: "mark", payload: { n: 1 } }));
  expect(err.message).toContain("stream paused");
});

test("a bare breaker-configured event (no payload) turns the breaker off", async () => {
  // The documented empty-payload off-switch is the recovery path for a tripped stream; the
  // spelling difference between `{}` and an absent payload must not decide whether recovery happens.
  const itx = openItx(freshCtx("barebreakeroff"));
  await append(itx, breakerConfigured(1, 0.000001));
  await append(itx, { type: "spend", payload: { n: 1 } }); // bucket → 0
  await append(itx, { type: "events.iterate.com/stream/breaker-configured" }); // documented off-switch
  expect((await coreState(itx)).breaker).toBeNull();
  const [after] = await append(itx, { type: "spend", payload: { n: 2 } });
  expect(after.offset).toBeGreaterThan(0);
});

test("pause refuses durable AND ephemeral appends, mixed batches wholesale — control passes", async () => {
  const itx = openItx(freshCtx("pause"));
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
  const itx = openItx(freshCtx("boundary"));
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
  // the `payload: {}` off-switch works too (the bare no-payload one is pinned above)
  await append(itx, { type: "events.iterate.com/stream/breaker-configured", payload: {} });
  expect((await coreState(itx)).breaker).toBeNull();
  const [freed] = await append(itx, { type: "spend", payload: { n: 5 } });
  expect(freed.offset).toBeGreaterThan(0);
});

test("breaker refills across a paused period and clamps at capacity", async () => {
  const itx = openItx(freshCtx("pausedrefill"));
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

test("breaker overdraft: an admitted batch drives tokens NEGATIVE, and the debt is CARRIED, not clamped", async () => {
  // DECIDED CONTRACT — carry the debt. Admission reads PRE-batch state, so a batch that carries
  // its own breaker-configured event is admitted while the breaker is still off; the reduce then
  // debits every durable event unconditionally (capacity 2, then d1..d4 → tokens -2). Clamping at
  // zero would forgive the overdraft the moment it happened; carrying it means refill must climb
  // THROUGH the debt before the stream takes durable writes again.
  const itx = openItx(freshCtx("overdraft"));
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

// ── read paging: the scanned-offset-range proof ──

test("read paging: a full page stops at its last row; a short page proves the durable log through its mark, never the ephemeral tail", async () => {
  const itx = openItx(freshCtx("paging"));
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
  // SHORT page from there: proves the scan reached the DURABLE mark — never the in-memory head,
  // whose ephemeral offsets a later incarnation may hand to durables (a reader that persisted one
  // would skip them). The ephemerals took offsets (eph[1] > durables[2]) but are not proven.
  const short = await read(itx, durables[2].offset, 3);
  expect(short.events).toHaveLength(0);
  expect(eph[1].offset).toBeGreaterThan(durables[2].offset);
  expect(short.scannedThroughOffset).toBe(durables[2].offset);
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

test("read(afterOffset beyond head) never claims a scan of unassigned offsets", async () => {
  // Scanned ranges are the contiguity currency of every consumer (facet cursors, subscription
  // healing, the operator's delivery-resumed seek): a scanned range can only cover offsets that
  // exist, or a cursor seeded from it would sit beyond head and skip every later event forever.
  const itx = openItx(freshCtx("readbeyond"));
  await append(itx, { type: "mark", payload: { n: 1 } }, { type: "mark", payload: { n: 2 } });
  // The TRUE head comes from a short-page read (platform events — woken, live-state deltas —
  // consume offsets beyond the last receipt, so a receipt offset under-approximates it).
  const head = (await read(itx)).scannedThroughOffset;
  const page = await read(itx, head + 100);
  expect(page.events).toEqual([]);
  expect(page.scannedThroughOffset).toBeLessThanOrEqual(head);
});
