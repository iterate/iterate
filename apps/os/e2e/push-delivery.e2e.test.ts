// push-delivery.e2e.test.ts — PUSH delivery: a live callback (`subscribe({ target: fn })`, a stub lent
// to `itx.rpcStubs` under `subscription:<name>`) OWNS ITS PROGRESS, so the one delivery loop pushes it
// `(events, { after, through })` fire-and-forget — no cursor row, no retry, no ack. (`consumes` is the
// ONE filter rule, consumesEvent — packages/iterate/src/stream/processor.test.ts; the pins that read the worker's
// console are push-delivery-no-dropped-warns.e2e, which owns a worker of its own.) Pins:
//   • delivered ranges CHAIN across a consumes-filtered quiet gap: the misses produce no empty sends and
//     the next range starts EXACTLY where the last ended (a client heals a real gap with `readEvents`)
//   • naming an ephemeral type opts it in and the consumes-less default excludes ephemerals — on the
//     wire, to a live callback
//   • `subscribe({ name, target: null })` stops deliveries at the removal offset
//   • a throwing callback never hurts the producer and is never retried; anonymous subscribes get
//     unique names and never shadow each other
//   • under volume: 2000 voice-chunk-shaped ephemerals (256 B payloads, batched appends) delivered
//     exactly once, contiguous and batched; one append fans out to 200 live subscribers exactly once
//     each and reaches 50 userspace processor facets; a 900-event commit arrives as ONE callback
//     invocation. NO WALL-CLOCK BUDGETS HERE: this file runs beside every other e2e file (16 at a
//     time, their rows concurrent) against one shared worker, so a latency it measures is the
//     suite's contention as much as the platform's (a 1.6 s whoami against a 1.5 s budget, main
//     f5fdb3cf; a 582 ms p50 against 500, #2962). The latency and throughput budgets are
//     perf/push-delivery.perf.test.ts, which runs alone; the lines printed here are for comparison

import { expect, test } from "vitest";
import { collector, freshCtx, openItx, sleep, until } from "./support/client.ts";
import { ephemeralFlood, fanProbes, pushSubscribers } from "./support/push-load.ts";

// ── ranges chain; the filter; removal; a throwing callback; anonymous names ──

test("delivered ranges CHAIN across a consumes-filtered quiet gap", async () => {
  const itx = openItx(freshCtx("chain"));
  const c = collector();
  await itx.subscribe({ name: "chain", consumes: ["hit"], target: c.fn });
  const [hit1] = await itx.append({ type: "hit" });
  await until("first delivery", () => c.invocations.length >= 1);
  // five durable non-matching events — a quiet gap the subscriber's filter skips entirely
  for (let i = 0; i < 5; i++) await itx.append({ type: "miss", payload: { i } });
  const [hit2] = await itx.append({ type: "hit" });
  await until("second delivery", () => c.invocations.length >= 2);
  await sleep(300);
  expect(c.invocations.length).toBe(2); // the misses must produce NO empty sends
  const [d1, d2] = c.invocations;
  expect(d1.events.map((e) => e.offset)).toEqual([hit1.offset]);
  expect(d2.events.map((e) => e.offset)).toEqual([hit2.offset]);
  // THE contract: the skipped span rides the next delivered range — d2 starts EXACTLY where d1
  // ended (one comparison client-side; a gap here would force a pull that must not be needed).
  expect(d2.range).toMatchObject({ after: d1.range.through, through: hit2.offset });
});

test("consumes naming an ephemeral type opts in; the consumes-less default excludes ephemerals", async () => {
  const itx = openItx(freshCtx("eph"));
  const optedIn = collector(); // names the ephemeral type — must receive it
  const dflt = collector(); // no consumes — durable events only
  await itx.subscribe({ name: "opted-in", consumes: ["chunk"], target: optedIn.fn });
  await itx.subscribe({ name: "default", target: dflt.fn });
  const [chunk] = await itx.append({ type: "chunk", ephemeral: true, payload: { n: 1 } });
  const [note] = await itx.append({ type: "note" });
  await until("opted-in got the ephemeral", () => optedIn.offsets().includes(chunk.offset));
  await until("default got the durable", () => dflt.offsets().includes(note.offset));
  await sleep(300);
  // the filter is exact (the ONE consumes rule, consumesEvent): the opted-in row saw ONLY its
  // named type; the default row NEVER saw the ephemeral (ephemerals must be named to be delivered)
  expect(optedIn.types()).toEqual(["chunk"]);
  expect(dflt.types()).not.toContain("chunk");
});

test("subscribe({ name, target: null }) stops deliveries at the removal offset", async () => {
  const itx = openItx(freshCtx("bye"));
  const c = collector();
  await itx.subscribe({ name: "bye", consumes: ["mark"], target: c.fn });
  const [m1] = await itx.append({ type: "mark" });
  const [m2] = await itx.append({ type: "mark" });
  await until("both pre-removal marks", () => c.offsets().length >= 2);
  await itx.subscribe({ name: "bye", target: null });
  await itx.append({ type: "mark" });
  await itx.append({ type: "mark" });
  await sleep(600);
  // nothing at or beyond the removal offset may arrive — the row died inside the removal commit
  expect([...c.offsets()].sort((a, b) => a - b)).toEqual([m1.offset, m2.offset]);
  expect(await itx.subscriptions.get("bye")).toBeNull();
});

test("a throwing subscriber callback never hurts the producer and is never retried", async () => {
  const itx = openItx(freshCtx("thrower"));
  let throws = 0;
  const witness = collector();
  await itx.subscribe({
    name: "thrower",
    consumes: ["mark"],
    target: () => {
      throws++;
      throw new Error("subscriber exploded");
    },
  });
  await itx.subscribe({ name: "witness", consumes: ["mark"], target: witness.fn });
  const [m1] = await itx.append({ type: "mark" }); // resolves — the producer is unaffected
  const [m2] = await itx.append({ type: "mark" });
  await until("witness got both", () => witness.offsets().length >= 2);
  await until("thrower was offered both", () => throws >= 2);
  await sleep(700); // a retry storm would keep incrementing
  expect(throws).toBe(2); // exactly one offer per batch — fire-and-forget means no ladder here
  expect([...witness.offsets()].sort((a, b) => a - b)).toEqual([m1.offset, m2.offset]);
  expect((await itx.subscriptions.get("thrower")).cursor).toBeUndefined(); // no cursor, so nothing to halt
});

test("concurrent anonymous subscribes get unique names and never shadow each other", async () => {
  // Each unnamed subscribe mints a unique `sub-<uuid>` name, so both deliver.
  const itx = openItx(freshCtx("anon"));
  const a = collector();
  const b = collector();
  const s1 = await itx.subscribe({ consumes: ["ping"], target: a.fn });
  const s2 = await itx.subscribe({ consumes: ["ping"], target: b.fn });
  expect(await s1.name).not.toBe(await s2.name); // `name` is a getter on the handle — one hop each
  const [ping] = await itx.append({ type: "ping" });
  await until(
    "both anonymous subscribers received the event",
    () => a.offsets().includes(ping.offset) && b.offsets().includes(ping.offset),
  );
});

// ── under volume ──

test("ephemeral flood: all chunks delivered exactly once, contiguous and batched", async () => {
  const flood = await ephemeralFlood(openItx(freshCtx("flood")));
  console.log(flood.line);
  // every seq exactly once: no loss at this volume, no duplicate
  expect(flood.seqs.toSorted((a, b) => a - b)).toEqual(
    Array.from({ length: flood.total }, (_, i) => i),
  );
  expect(flood).toMatchObject({ contiguityBroken: false }); // delivered ranges CHAIN, zero pulls
  expect(flood.callbackInvocations).toBeLessThan(flood.total); // BATCH-FIRST: far fewer callbacks
}, 60_000);

test("200 push subscribers — one append fans out to all 200, exactly once each", async () => {
  const fan = await pushSubscribers(openItx(freshCtx("fan200")), 200);
  const t0 = Date.now();
  await fan.ping(2);
  await fan.delivered(2);
  console.log(
    `fan-out: cold(first-page) ${fan.coldWallMs}ms, warm ${Date.now() - t0}ms for 200 subscribers`,
  );
  await sleep(300);
  expect(fan.counts.every((c) => c === 2)).toBe(true); // exactly once per round, no dup fan-out
}, 90_000);

test("50 userspace processors: one append reaches all 50", async () => {
  const itx = openItx(freshCtx("fan50"));
  const probes = await fanProbes(itx, 50);
  const t0 = performance.now();
  const offset = await probes.mark();
  await probes.reached(offset);
  console.log(
    `[fan-out] all 50 processors reached offset ${offset} in ${(performance.now() - t0).toFixed(0)}ms`,
  );
  // a mid-pack processor really reduced the log (each enable event + the marker)
  const snap = await itx.invoke(`itx.facets.get('fan7').snapshot()`);
  expect(snap.offset).toBeGreaterThanOrEqual(offset);
  expect((snap.state as { n: number }).n).toBeGreaterThan(0);
}, 90_000);

test("an append of 900 events in one batch arrives as ONE callback invocation (batch preserved)", async () => {
  const itx = openItx(freshCtx("bigbatch"));
  const c = collector();
  await itx.subscribe({ name: "bulk", consumes: ["bulk"], target: c.fn });
  const batch = Array.from({ length: 900 }, (_, i) => ({ type: "bulk", payload: { i } }));
  const committed = await itx.append(...batch);
  expect(committed).toHaveLength(900);
  await until("all 900 delivered", () => c.offsets().length >= 900, 30_000);
  expect(c.invocations).toHaveLength(1); // ONE commit = ONE delivery — the batch is never split
  expect(c.invocations[0].events).toHaveLength(900);
  expect(c.invocations[0].range).toMatchObject({ through: committed[899].offset });
});
