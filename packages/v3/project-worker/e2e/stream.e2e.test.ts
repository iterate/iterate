// stream.e2e.test.ts — THE EVENT LOG through `itx.append` / `itx.readEvents` / `itx.waitForEvent`
// (`Stream` in stream/stream.ts, whose mechanics are src/stream/stream.test.ts; this file proves the
// doors end to end through the real DO). Pins:
//   • the WAKE RECORD: the DO's constructor appends `stream/created` @1 and `stream/woken` @2 before
//     any door opens, the config-worker funnel's `subscription-configured` lands @4, and the first user
//     append lands @6 (3 and 5 are ephemeral core live-state deltas); the core reduce carries identity
//     + incarnation; woken exactly once per incarnation, created once ever
//   • the ONE inline reduced state is live under ONE key, `core`: a rewrite rule and a subscription row
//     both reach a live-state subscriber as `core` deltas, and nothing publishes under another key
//   • the append door's runtime guards; idempotency at the commit point (an in-batch hit reduced ONCE
//     by the commit-point reduce, a mid-batch conflict rolling the whole batch back and burning no
//     offset, a hit interleaved with fresh events, two sessions' concurrent appends keeping offsets
//     unique)
//   • payload depth near the codec's budget (64-deep, an idempotent retry of it, the JSON5 string half)
//   • the pause slice (control is ordinary events; enforcement reads the reduce — the policy that
//     DECIDES to pause is processor-facets.e2e's breaker): a bare `stream/paused` pauses; durable AND
//     ephemeral appends refuse, mixed batches wholesale, the resume always lands; a subscribe REFUSED
//     while paused recalls nothing it lent
//   • read paging's scanned-offset-range proof: a full page stops at its last row, a short page proves
//     the DURABLE mark (never the ephemeral tail), a read beyond head claims no unassigned offsets
//   • row CHUNKING: a >2 MB body commits as ONE dense event and round-trips byte-identically through
//     the real DO SQLite (event_chunks), an idempotent chunked retry dedupes, a mid-batch conflict rolls
//     the chunk rows back, chunk rows stay invisible to paging, a surrogate pair straddling a chunk
//     boundary survives (the JSON is sliced by UTF-16 code units)
//   • `waitForEvent` through a LOADED worker's `env.ITX.get()` — the scope's door waits on the DO and
//     returns the committed event (the Workers-RPC lane no other suite drives)
//   • OPT-IN, deployed only (RUN_WAKE_LOOP_PROBE=1): the self-wake billing control — a stuck cursor
//     delivery on a dormant context self-wakes on the DO's alarm and the circuit breaker halts it

import { expect, test } from "vitest";
import type { LiveStateDelta } from "../src/client/live-state.ts";
import {
  append,
  collector,
  disposeSessions,
  freshCtx,
  openItx,
  readAll,
  readHead,
  rejection,
  sleep,
  until,
} from "./support/client.ts";
import { projectHostsAreLocal } from "./support/project-host.ts";
import { enableFixtureProcessor } from "./support/sources.ts";

// ── the wake record and the inline live state ──

test("any door materializes a fresh context: readEvents(0) starts with created then woken; the first append lands past them; core's reduced state carries identity + incarnation", async () => {
  const ctx = freshCtx("woken");
  const itx = openItx(ctx);
  // A bare READ on a never-touched context already sees the birth records — the constructor wrote
  // them before this door opened. The config-worker funnel auto-subscribes `config` at birth, so a
  // durable subscription-configured record lands at offset 4 (offsets 3 and 5 are ephemeral core
  // live-state deltas, which durable readEvents never returns).
  const page = await itx.invoke("itx.readEvents(0)");
  expect(page.events.map((e: { type: string; offset: number }) => [e.type, e.offset])).toEqual([
    ["events.iterate.com/stream/created", 1],
    ["events.iterate.com/stream/woken", 2],
    ["events.iterate.com/stream/subscription-configured", 4],
  ]);
  expect(page.events[0].payload).toEqual({ projectId: ctx, path: "/" });
  expect(page.events[2].payload.name).toBe("config"); // the auto-subscribed config-worker funnel
  const incarnation = page.events[1].payload.incarnation;
  expect(incarnation).toBeGreaterThanOrEqual(1);

  // one receipt per INPUT — the platform's records are never echoed as receipts — and the first
  // user append lands at offset 6: past created (1), woken (2), the wake commit's ephemeral
  // live-state delta (3), the config subscription-configured record (4) and its ephemeral
  // live-state delta (5; ephemerals share the offset sequence but are not durable).
  const receipts = await itx.invoke(`itx.append({ type: 'hello' })`);
  expect(receipts).toHaveLength(1);
  expect(receipts[0].type).toBe("hello");
  expect(receipts[0].offset).toBe(6);

  // the core reduce reduced both records — runtime state IS reduced state
  const snap = await itx.invoke("itx.facets.get('core').snapshot()");
  expect(snap.state).toMatchObject({ projectId: ctx, path: "/", incarnation });
  expect(snap.state.createdAt).toBe(page.events[0].createdAt);

  // exactly once per incarnation (and born exactly once, ever)
  await itx.invoke(`itx.append({ type: 'again' })`);
  const types = (await itx.invoke("itx.readEvents(0)")).events.map((e: { type: string }) => e.type);
  expect(types.filter((t: string) => t === "events.iterate.com/stream/woken")).toHaveLength(1);
  expect(types.filter((t: string) => t === "events.iterate.com/stream/created")).toHaveLength(1);
});

test("the inline reduced state is live under ONE key, `core`: a rewrite rule and a subscription row both reach a live-state subscriber as `core` deltas", async () => {
  const itx = openItx(freshCtx("inlinelive"));
  await itx.invoke(`itx.append({ type: 'seed' })`);

  // ONE event type carries every key's deltas; a subscriber keeps its key. One collector sees them
  // all, so it can also prove nothing publishes under any key but `core` (its slices — rewrite rules,
  // subscriptions — are never keys of their own).
  const deltas = collector();
  await itx.subscribe({
    name: "corewatch",
    target: deltas.fn,
    consumes: ["events.iterate.com/live-state/changed"],
  });
  const delivered = (): LiveStateDelta[] =>
    deltas.invocations.flatMap((i) => i.events.map((e) => e.payload as LiveStateDelta));

  // a REWRITE RULE (a rewrite) → a delta keyed "core" whose patch touches /itxExpressionRewriteRules
  await itx.provide("itx.zzz", "itx.whoami");
  const ruleDelta = await until("core delta for the rewrite rule", () =>
    delivered().find((d) =>
      d.patch?.some((op) => op.path.startsWith("/itxExpressionRewriteRules")),
    ),
  );
  expect(ruleDelta.key).toBe("core");
  expect(ruleDelta.to).toBe(ruleDelta.from + 1); // each emission chains its producer revision

  // a SUBSCRIPTION ROW (a subscribe) → a delta keyed "core" whose patch touches /subscriptions
  await itx.subscribe({ name: "bystander", target: "itx.whoami", consumes: ["never"] });
  const rowDelta = await until("core delta for the row", () =>
    delivered().find((d) => d.patch?.some((op) => op.path.startsWith("/subscriptions/bystander"))),
  );
  expect(rowDelta.key).toBe("core");
  expect(rowDelta.to).toBe(rowDelta.from + 1);

  // and nothing ever published under any other key
  expect(new Set(delivered().map((d) => d.key))).toEqual(new Set(["core"]));
});

// ── the commit point: guards, idempotency, depth, the pause slice, paging ──

const read = (
  itx: any,
  afterOffset?: number,
  limit?: number,
): Promise<{ events: any[]; scannedThroughOffset: number }> =>
  itx.invoke([
    "itx",
    [
      "readEvents",
      ...(afterOffset === undefined
        ? []
        : limit === undefined
          ? [afterOffset]
          : [afterOffset, limit]),
    ],
  ]);

// ── the append door's runtime guards ──

test("the runtime guard rejects a non-string or blank type, committing nothing", async () => {
  // There is no TS-type allow-list on the RPC boundary; the ONE explicit runtime guard in
  // Stream.append is the sole enforcement.
  const itx = openItx(freshCtx("guards"));
  expect((await rejection(append(itx, { type: 12345 }))).message).toMatch(/non-empty type/i);
  expect((await rejection(append(itx, { type: "" }))).message).toMatch(/non-empty type/i);
  expect((await rejection(append(itx, { type: "   " }))).message).toMatch(/non-empty type/i);
  expect((await readAll(itx)).map((e) => e.type)).not.toContain("sneaky"); // nothing committed
});

test("an in-batch idempotency dedupe hit is processed ONCE, not twice", async () => {
  // append derives a per-offset `distinct` view (first-wins) that feeds the inline core reduce AND
  // the delivery, so each durable event is processed ONCE — while the returned `committed` keeps one
  // receipt per input. Core's own slices are maps (a double reduce of a rewrite-rule set is
  // invisible), so the zero-distance witness is a counting facet processor fed by the same distinct
  // view: an event duplicated in one batch under one idempotencyKey must be counted exactly ONCE.
  const itx = openItx(freshCtx("dupbatch"));
  await enableFixtureProcessor(itx, "tally");
  const duplicated = { type: "dup", payload: { n: 1 }, idempotencyKey: "dup-in-batch" };
  const pair = await append(itx, duplicated, duplicated);
  // The dedupe itself is right: both entries answer with the ONE committed offset…
  expect(pair).toHaveLength(2);
  expect(pair[1].offset).toBe(pair[0].offset);
  const page = await read(itx);
  expect(page.events.filter((e) => e.idempotencyKey === "dup-in-batch")).toHaveLength(1);
  // …and the distinct view reached the facet exactly ONCE: one `dup` counted, at the head.
  const head = await readHead(itx);
  const snap: any = await until("tally at head", async () => {
    const s: any = await itx.invoke("itx.facets.get('tally').snapshot()");
    return s.offset >= head && s;
  });
  expect(snap.state.counts.dup).toBe(1);
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
    const [committed] = await itx.invoke(
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

// ── the core reduce's pause slice (control is ordinary events; enforcement reads the reduce) ──

test("a bare stream/paused event (no payload) actually pauses the stream", async () => {
  // the core reduce defaults `event.payload ?? {}` — a pause that silently doesn't pause
  // would be an operator trap (the control fact is in the log while writes keep landing).
  const itx = openItx(freshCtx("barepause"));
  await append(itx, { type: "events.iterate.com/stream/paused" });
  const err = await rejection(append(itx, { type: "mark", payload: { n: 1 } }));
  expect(err.message).toContain("stream paused");
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

test("a subscribe REFUSED by a paused stream leaves the live same-name subscription lent — the row is appended before the session recalls what it lent under the name", async () => {
  // iterate-context.ts `subscribe`: an expression target appends its row FIRST and only then
  // recalls the callback this session lent under `subscription:<name>` — a refusal changes nothing.
  // The other order recalled the callback (its pager closed, the stub returned) and THEN met the
  // refusal: a refused subscribe had silently destroyed the subscription it failed to replace.
  const itx = openItx(freshCtx("pausesub"));
  await itx.subscribe({ name: "watch", target: () => undefined });
  expect(await itx.rpcStubs.list()).toContain("subscription:watch");
  await append(itx, {
    type: "events.iterate.com/stream/paused",
    payload: { reason: "maintenance" },
  });
  const refused = await rejection(itx.subscribe({ name: "watch", target: "itx.kv.get('k')" }));
  expect(refused.message).toContain("stream paused");
  expect(await itx.rpcStubs.list()).toContain("subscription:watch"); // still lent: nothing was recalled
  await append(itx, { type: "events.iterate.com/stream/resumed", payload: {} });
  expect(await itx.rpcStubs.list()).toContain("subscription:watch"); // and the resume un-sets nothing: the key has its transport
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

test("readEvents(afterOffset beyond head) never claims a scan of unassigned offsets", async () => {
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

// ── row chunking ──

const readOne = async (itx: any, offset: number) =>
  (await itx.invoke(["itx", ["readEvents", offset - 1, 1]])).events[0];

test("a ~256KB payload round-trips byte-identically (the in-bounds control)", async () => {
  const itx = openItx(freshCtx("chunkctl"));
  const blob = "x".repeat(256 * 1024);
  const [committed] = await append(itx, { type: "mid", payload: { blob } });
  expect((await readOne(itx, committed.offset)).payload.blob === blob).toBe(true);
});

test("5MB chunked body: single dense event, byte-identical round-trip, idempotent dedupe", async () => {
  const ctx = freshCtx("chunk");
  const itx = openItx(ctx);

  // A small event, then a 5MB body, then a small event — dense offsets on both sides. (The
  // context's constructor minted created + woken and the core reduce's ephemeral live-state delta
  // before any door opened; `small-before` is appended twice so the two receipts are adjacent — a
  // plain event changes no core state, so nothing ephemeral lands between them.)
  await append(itx, { type: "small-before" });
  const [before] = await append(itx, { type: "small-before" });
  const blob = "y".repeat(5 * 1024 * 1024);
  const big = await append(itx, { type: "big", payload: { blob } });
  const [after] = await append(itx, { type: "small-after" });
  expect(big.length).toBe(1); // 5MB body committed as ONE event (not split)
  expect(big[0].offset).toBe(before.offset + 1); // dense with its predecessor
  expect(after.offset).toBe(big[0].offset + 1); // and with its successor

  // Read it back through a FRESH session (same ctx) — a real storage reassembly, not an echo.
  const itx2 = openItx(ctx);
  const page = await itx2.invoke(["itx", ["readEvents", before.offset, 500]]);
  const back = page.events.find((e: { offset: number }) => e.offset === big[0].offset);
  expect(back?.type).toBe("big");
  expect(back?.payload?.blob === blob).toBe(true); // byte-identical (identity check — never a 5MB diff)
  // chunk rows invisible to paging (dense event list)
  expect(page.events.map((e: { type: string }) => e.type).join(",")).toBe("big,small-after");

  // An idempotent RETRY of a large chunked payload dedupes to the same offset.
  const keyed = { type: "big-keyed", payload: { blob }, idempotencyKey: "chunk-once" };
  const [k1] = await append(itx, keyed);
  const [k2] = await append(itx, keyed);
  expect(k2.offset).toBe(k1.offset);
});

test("a chunked append followed by an idempotency CONFLICT in the same batch rolls back ALL chunk rows", async () => {
  // Chunk rows are the first multi-row write in the commit path; a torn mid-batch failure leaving
  // orphan chunk rows (or half a body) is the corruption class chunking introduces — the rollback
  // must be provably whole, and the allocator must burn no offsets for the refused batch.
  const itx = openItx(freshCtx("chunkrb"));
  const [pin] = await append(itx, { type: "pin", payload: { v: 1 }, idempotencyKey: "pin" });
  const blob = "r".repeat(3 * 1024 * 1024);
  await expect(
    append(
      itx,
      { type: "big-victim", payload: { blob } },
      { type: "pin", payload: { v: 2 }, idempotencyKey: "pin" }, // same key, DIFFERENT body → conflict
    ),
  ).rejects.toThrow(/idempotency key "pin" already names a different event/);
  // Nothing partial survived the rollback (presence/absence — woken shares the log)…
  const types = (await readAll(itx)).map((e) => e.type as string);
  expect(types.filter((t) => t === "pin")).toHaveLength(1);
  expect(types).not.toContain("big-victim");
  expect(pin.offset).toBeGreaterThan(0);
  // …and the allocator did not burn offsets for a rolled-back batch: a marker before a second
  // refused chunked batch and a probe after it land adjacent.
  const [marker] = await append(itx, { type: "marker" });
  await expect(
    append(
      itx,
      { type: "big-victim", payload: { blob } },
      { type: "pin", payload: { v: 3 }, idempotencyKey: "pin" },
    ),
  ).rejects.toThrow(/idempotency key "pin" already names a different event/);
  const [next] = await append(itx, { type: "after-rollback" });
  expect(next.offset).toBe(marker.offset + 1);
}, 60_000);

test("read paging across a chunked event keeps the scanned-offset-range proof honest", async () => {
  // Every processor cursor and gap repair trusts the scanned-offset-range proof; if chunk rows ever
  // leaked into the page arithmetic, cursors would advance to phantom offsets and repairs would
  // skip real events. A limit-N page counts EVENTS, its scannedThroughOffset is the last EVENT row's
  // offset when the page is full (never a chunk boundary), and consecutive pages chain.
  const itx = openItx(freshCtx("chunkpg"));
  const blob = "p".repeat(3 * 1024 * 1024);
  const [, e2] = await append(itx, { type: "e1" }, { type: "e2" });
  const [big] = await append(itx, { type: "big", payload: { blob } });
  const [e4, e5] = await append(itx, { type: "e4" }, { type: "e5" });
  // Page 1: a FULL page (limit 2 from just before e2) lands exactly ON the chunked event.
  const page1 = await itx.invoke(["itx", ["readEvents", e2.offset - 1, 2]]);
  expect(page1.events.map((e: { offset: number }) => e.offset)).toEqual([e2.offset, big.offset]);
  expect(page1.scannedThroughOffset).toBe(big.offset); // the EVENT offset — never a chunk row's
  expect(page1.events[1].payload.blob === blob).toBe(true); // the body rode the page whole
  // Page 2 chains contiguously from the proof.
  const page2 = await itx.invoke(["itx", ["readEvents", page1.scannedThroughOffset, 500]]);
  expect(page2.events.map((e: { offset: number }) => e.offset)).toEqual([e4.offset, e5.offset]);
  expect(page2.scannedThroughOffset).toBe(e5.offset);
}, 60_000);

const EVENT_CHUNK_SIZE = 512 * 1024; // must match src/stream/stream.ts
const EMOJI = String.fromCodePoint(0x1f600); // "grinning face" = high+low surrogate pair

test("a surrogate pair straddling a chunk boundary round-trips byte-identically", async () => {
  // The serialized JSON is sliced every EVENT_CHUNK_SIZE UTF-16 code units into TEXT cells; a
  // surrogate pair split across the boundary would be two LONE surrogates in two cells, which
  // SQLite's UTF-8 TEXT binding cannot hold — reassembly would hand back U+FFFD.
  const ctx = freshCtx("chunksur");
  const itx = openItx(ctx);

  // Where does the blob's first char land inside the server's serialized JSON? The server
  // serializes `{ ...input, createdAt }`; createdAt is appended AFTER, so the prefix before the
  // blob content equals this sample's prefix (index of MARKER = blob[0]'s position).
  const prefixLen = JSON.stringify({ type: "big", payload: { blob: "MARKER" } }).indexOf("MARKER");
  expect(prefixLen).toBeGreaterThan(0);

  // Put the HIGH surrogate at server-JSON index EVENT_CHUNK_SIZE-1 (last unit of chunk 0) so the
  // LOW surrogate lands at index EVENT_CHUNK_SIZE (first unit of chunk 1): the pair is split.
  const highAtBlobIndex = EVENT_CHUNK_SIZE - 1 - prefixLen;
  const blob = "a".repeat(highAtBlobIndex) + EMOJI + "a".repeat(64);
  const hi = blob.charCodeAt(highAtBlobIndex);
  expect(hi).toBeGreaterThanOrEqual(0xd800);
  expect(hi).toBeLessThanOrEqual(0xdbff);

  const [committed] = await append(itx, { type: "big", payload: { blob } });
  expect(committed.payload.blob).toBe(blob); // the echo is the in-memory object — always intact

  // Read back through a FRESH session → a real reassembly from event_chunks, not an echo.
  const back = await readOne(openItx(ctx), committed.offset);
  expect(back).toBeTruthy();
  const got: string = back.payload.blob;
  const window = (s: string) =>
    JSON.stringify(
      [...s.slice(highAtBlobIndex - 1, highAtBlobIndex + 2)].map((c) =>
        c.codePointAt(0)?.toString(16),
      ),
    );
  expect(
    got === blob,
    `blob NOT byte-identical around the split boundary — expected code units ${window(blob)}, ` +
      `got ${window(got)} (U+fffd = replacement char)`,
  ).toBe(true);
});

// ── waitForEvent through the loaded-worker lane ──

test("waitForEvent through a LOADED worker's env.ITX.get() — the scope's dotted door waits on the DO and returns the event", async () => {
  const ctx = freshCtx("waitload");
  const itxA = openItx(ctx);
  const itxB = openItx(ctx);
  // The door under test is `waitForEvent` on the itx scope a loaded worker holds (`env.ITX.get()` —
  // the ItxEntrypoint has no stream verbs of its own: `get` and `fetch` only). A real entrypoint is
  // loaded: its `run` opens the wait through the scope, a second session appends, and the loaded
  // worker returns the committed event — the Workers-RPC lane no other suite drives.
  const SRC_WAITER = {
    "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Waiter extends WorkerEntrypoint {
  async run(afterOffset) {
    const itx = await this.env.ITX.get();
    return await itx.waitForEvent({ type: "ping", afterOffset, timeoutMs: 20000 });
  }
}`,
  };
  const head = (await itxA.invoke("itx.readEvents(0)")).scannedThroughOffset;
  const pending = itxA.invoke(["itx", "workers", ["get", { source: SRC_WAITER }], ["run", head]]);
  await sleep(500); // let the loaded worker start waiting before the append (the anchored afterOffset makes either order correct)
  await itxB.invoke(`itx.append({ type: 'ping', payload: { via: 'entrypoint' } })`);
  const got = await pending;
  expect(got.type).toBe("ping");
  expect(got.payload).toEqual({ via: "entrypoint" });
  expect(got.offset).toBeGreaterThan(head);
});

// ── THE SELF-WAKE BILLING CONTROL (stream.ts SELF_WAKE_HALT_STREAK): the DEPLOYED, EVICTION-RATE-
// DEPENDENT observation — the control itself is proven deterministically in src/stream/stream.test.ts
// (halts at N, resumes on a public door, durable across incarnations); its DO wiring is live. Measured
// deployed (2026-09-07), the self-wake loop is a SLOW DRIP, not a runaway: the streak only advances on
// an EVICTED, no-public-door incarnation (the incarnation that handled a request holds
// #publicDoorTouched for its whole life), and evictions are Cloudflare-timed — a cursor-sub-on-
// `stream/woken` drips ~+2 `woken` / 8 min; a stuck-retry cursor got 3 in 90 s. Reaching N takes
// minutes and varies run to run, so this row is OPT-IN (never on the board) — run it by hand and record
// `streak reached k`:
//
//   RUN_WAKE_LOOP_PROBE=1 WORKER_BASE_URL=https://project-worker.iterate.workers.dev \
//     pnpm e2e stream.e2e ──

const OPT_IN = process.env.RUN_WAKE_LOOP_PROBE === "1";
const probe = test.skipIf(projectHostsAreLocal() || !OPT_IN);
const WOKEN = "events.iterate.com/stream/woken";
const HALTED = "events.iterate.com/stream/self-wake-halted";

/** A cursor target that ALWAYS throws a plain (retryable) error — the stuck delivery whose retry
 *  ladder self-wakes fastest (the stream keeps its cursor; an entrypoint cannot own progress). */
const THROWING_WORKER = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Thrower extends WorkerEntrypoint {
  async processEventBatch(events, range) { throw new Error("wake-loop: this delivery always fails (retryable)"); }
}`,
};

const IDLE_MS = 11 * 60_000; // long enough for several evicted no-door self-wakes to accrue toward N

probe(
  "OBSERVE (opt-in): a stuck cursor delivery on a dormant context self-wakes; the circuit-breaker halts it — records streak reached",
  { timeout: IDLE_MS + 120_000 },
  async () => {
    const ctx = freshCtx("wake-loop");
    const itx = openItx(ctx);
    await itx.provide("itx.faildeliver", ["itx", "workers", ["get", { source: THROWING_WORKER }]]);
    await itx.subscribe({
      name: "faildeliver",
      target: "itx.faildeliver.processEventBatch",
      consumes: ["kick"],
    });
    await append(itx, { type: "kick", payload: { n: 1 } }); // kicks the ladder
    disposeSessions(); // disconnect — the ladder runs off the DO's own alarm, untouched
    await sleep(IDLE_MS);

    const events = await readAll(openItx(ctx)); // one read at the end (the halt, if any, already happened)
    const selfWakeHalts = events.filter((e) => e.type === HALTED).length;
    const woken = events.filter((e) => e.type === WOKEN).length;
    const streakReached = Number(
      (events.find((e) => e.type === HALTED)?.payload as { streak?: number } | undefined)?.streak ??
        0,
    );
    console.log(
      `wake-loop OBSERVE: over ${IDLE_MS / 60000}min — woken=${woken}, self-wake-halted=${selfWakeHalts}, streak reached=${streakReached || "<N (drip too slow this run)"}`,
    );
    // The context is never poisoned by the loop or the halt; the durable log survives.
    const [ev] = await append(openItx(ctx), { type: "after-observe" });
    expect(ev.offset).toBeGreaterThan(0);
    // If the drip reached N this run, the halt was recorded exactly once — the control fired.
    if (selfWakeHalts > 0) expect(selfWakeHalts).toBe(1);
  },
);
