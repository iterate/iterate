// push-delivery-ranges-chain.e2e.test.ts — PUSH: a live callback (`subscribe({ target: fn })`, a stub
// lent to `itx.rpcStubs` under `subscription:<name>`) OWNS ITS PROGRESS, so the one delivery
// loop pushes it `(events, { after, through })` fire-and-forget — no cursor row, no retry, no ack.
// Delivered ranges CHAIN across a consumes-filtered quiet gap (the client heals a real gap with
// `read`); `consumes` is the ONE filter rule (naming a type opts its ephemerals in; absent or "*" =
// every durable event); `subscribe({ name, target: null })` stops deliveries at the removal offset;
// a throwing callback never hurts the producer and is never retried; anonymous subscribes never
// shadow each other.

import { expect, test } from "vitest";
import { append, collector, freshCtx, openItx, sleep, until } from "./support/client.ts";

const row = async (itx: any, name: string): Promise<any> => itx.subscriptions.get(name);

test("delivered ranges CHAIN across a consumes-filtered quiet gap", async () => {
  const itx = openItx(freshCtx("chain"));
  const c = collector();
  await itx.subscribe({ name: "chain", consumes: ["hit"], target: c.fn });
  const [hit1] = await append(itx, { type: "hit" });
  await until("first delivery", () => c.invocations.length >= 1);
  // five durable non-matching events — a quiet gap the subscriber's filter skips entirely
  for (let i = 0; i < 5; i++) await append(itx, { type: "miss", payload: { i } });
  const [hit2] = await append(itx, { type: "hit" });
  await until("second delivery", () => c.invocations.length >= 2);
  await sleep(300);
  expect(c.invocations.length).toBe(2); // the misses must produce NO empty sends
  const [d1, d2] = c.invocations;
  expect(d1.events.map((e) => e.offset)).toEqual([hit1.offset]);
  expect(d2.events.map((e) => e.offset)).toEqual([hit2.offset]);
  // THE contract: the skipped span rides the next delivered range — d2 starts EXACTLY where d1
  // ended (one comparison client-side; a gap here would force a pull that must not be needed).
  expect(d2.range.after).toBe(d1.range.through);
  expect(d2.range.through).toBe(hit2.offset);
});

test("consumes naming an ephemeral type opts in; the consumes-less default excludes ephemerals", async () => {
  const itx = openItx(freshCtx("eph"));
  const optedIn = collector(); // names the ephemeral type — must receive it
  const dflt = collector(); // no consumes — durable events only
  await itx.subscribe({ name: "opted-in", consumes: ["chunk"], target: optedIn.fn });
  await itx.subscribe({ name: "default", target: dflt.fn });
  const [chunk] = await append(itx, { type: "chunk", ephemeral: true, payload: { n: 1 } });
  const [note] = await append(itx, { type: "note" });
  await until("opted-in got the ephemeral", () => optedIn.offsets().includes(chunk.offset));
  await until("default got the durable", () => dflt.offsets().includes(note.offset));
  await sleep(300);
  // the filter is exact (the ONE consumes rule, consumesEvent): the opted-in row saw ONLY its
  // named type; the default row NEVER saw the ephemeral (ephemerals must be named to be delivered)
  expect(optedIn.types()).toEqual(["chunk"]);
  expect(dflt.types()).not.toContain("chunk");
});

test("consumes ['*'] delivers every durable event to a push target", async () => {
  // One rule for every target — `consumesEvent` (stream/processor.ts): "*" = every durable event
  // (never a literal type name that matches nothing).
  const itx = openItx(freshCtx("star"));
  const star = collector();
  const control = collector();
  await itx.subscribe({ name: "star", consumes: ["*"], target: star.fn });
  await itx.subscribe({ name: "control", consumes: ["note"], target: control.fn });
  const [note] = await append(itx, { type: "note" });
  await until("control got it (the lane works)", () => control.offsets().includes(note.offset));
  await sleep(400);
  expect(star.offsets()).toContain(note.offset);
});

test("subscribe({ name, target: null }) stops deliveries at the removal offset", async () => {
  const itx = openItx(freshCtx("bye"));
  const c = collector();
  await itx.subscribe({ name: "bye", consumes: ["mark"], target: c.fn });
  const [m1] = await append(itx, { type: "mark" });
  const [m2] = await append(itx, { type: "mark" });
  await until("both pre-removal marks", () => c.offsets().length >= 2);
  await itx.subscribe({ name: "bye", target: null });
  await append(itx, { type: "mark" });
  await append(itx, { type: "mark" });
  await sleep(600);
  // nothing at or beyond the removal offset may arrive — the row died inside the removal commit
  expect([...c.offsets()].sort((a, b) => a - b)).toEqual([m1.offset, m2.offset]);
  expect(await row(itx, "bye")).toBeNull();
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
  const [m1] = await append(itx, { type: "mark" }); // resolves — the producer is unaffected
  const [m2] = await append(itx, { type: "mark" });
  await until("witness got both", () => witness.offsets().length >= 2);
  await until("thrower was offered both", () => throws >= 2);
  await sleep(700); // a retry storm would keep incrementing
  expect(throws).toBe(2); // exactly one offer per batch — fire-and-forget means no ladder here
  expect([...witness.offsets()].sort((a, b) => a - b)).toEqual([m1.offset, m2.offset]);
  expect((await row(itx, "thrower")).cursor).toBeUndefined(); // no cursor, so nothing to halt
});

test("concurrent anonymous subscribes get unique names and never shadow each other", async () => {
  // Each unnamed subscribe mints a unique `sub-<uuid>` name, so both deliver.
  const itx = openItx(freshCtx("anon"));
  const a = collector();
  const b = collector();
  const s1 = await itx.subscribe({ consumes: ["ping"], target: a.fn });
  const s2 = await itx.subscribe({ consumes: ["ping"], target: b.fn });
  expect(await s1.name).not.toBe(await s2.name); // `name` is a getter on the handle — one hop each
  const [ping] = await append(itx, { type: "ping" });
  await until(
    "both anonymous subscribers received the event",
    () => a.offsets().includes(ping.offset) && b.offsets().includes(ping.offset),
  );
});
