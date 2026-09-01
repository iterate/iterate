// __tests__/failing-delivery.test.ts — BUG HUNT over THE ONE subscription delivery loop
// (src/stream/subscription-delivery.ts). Nothing is declared: the loop evaluates each subscription's
// target and looks at the value —
//   • a LIVE STUB (`itx.rpcStubs.get(…)`, what `subscribe({ target: fn })` parks) or a FACET OWNS
//     ITS PROGRESS ⇒ a fire-and-forget PUSH of `(events, { after, through })`, ranges must CHAIN,
//     the client heals a gap with `read`; no cursor row;
//   • anything else — here a Worker-Loader entrypoint's `processEventBatch` — cannot ⇒ THE STREAM
//     KEEPS A CURSOR (`itx.subscriptions.get(name).cursor`), at-least-once, the awaited call is the
//     ack, one ladder (1s·2ⁿ ≤ 30min, 15 attempts; `retryable: false` halts at once) then the
//     `subscription-delivery-halted` FACT; recovery is the operator's ONE event,
//     `subscription-delivery-resumed { name, afterOffset? }`, a plain append.
//
// Every test asserts CORRECT behavior. `test.fails` marks behavior VERIFIED BROKEN by running
// against the real worker (wrangler createTestHarness) — each carries BUG/EXPECTED/ACTUAL/WHY.
// Run: pnpm exec vitest run --project harness failing-delivery

import { createRequire } from "node:module";
import { dirname } from "node:path";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { afterAll, beforeAll, expect, test } from "vitest";
import { seedSources } from "../e2e/support/sources.ts";
import { startProjectHarness, type ProjectHarness } from "./harness.ts";

let harness: ProjectHarness;
beforeAll(async () => {
  harness = await startProjectHarness();
}, 120_000);
afterAll(async () => {
  await harness?.stop();
});

// ── the shared idioms: until-loops with hard deadlines, a delivery collector, append sugar ──

async function until<T>(
  label: string,
  fn: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 20_000,
  pollMs = 50,
): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs)
      throw new Error(`until(${label}): timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Range = { after: number; through: number };

const CONFIGURED = "events.iterate.com/stream/subscription-configured";
const HALTED = "events.iterate.com/stream/subscription-delivery-halted";
const RESUMED = "events.iterate.com/stream/subscription-delivery-resumed";

/** The subscriptions table joined with the stream-kept cursors (`itx.subscriptions.list()`): a row
 *  is PURE DATA — `{ name, target, consumes?, configuredAtOffset, cursor?, halted? }`. A live
 *  subscriber's target names the registry (`itx.rpcStubs.get('itx.subscriptions.<name>')`) and says
 *  nothing about whether that stub is online — PRESENCE is `itx.rpcStubs.list()`. `cursor` is
 *  present ONLY for a target the stream delivers at-least-once. */
const rows = async (itx: any): Promise<any[]> => (await itx.subscriptions.list()) as any[];
const row = async (itx: any, name: string): Promise<any> => itx.subscriptions.get(name);

/** A subscriber callback that records every invocation (deep-cloned — capnweb payloads must not
 *  be read after the callback's turn). Works verbatim on BOTH kinds of target: a push target gets
 *  it directly; a cursor target reaches it through the hooked worker below. */
function collector() {
  const invocations: { events: any[]; range: Range }[] = [];
  return {
    fn: (events: any[], range: Range) => {
      invocations.push(JSON.parse(JSON.stringify({ events, range })));
    },
    invocations,
    offsets: () => invocations.flatMap((i) => i.events.map((e) => e.offset as number)),
    types: () => invocations.flatMap((i) => i.events.map((e) => e.type as string)),
  };
}

const append = (itx: any, ...events: unknown[]) =>
  itx.invokeCapability(["itx", ["append", ...events]]);
const readAll = async (itx: any): Promise<any[]> =>
  (await itx.invokeCapability(["itx", ["read", 0, 500]])).events;
/** PRESENCE — the keys with an open transport right now (`itx.rpcStubs.list()`). */
const presence = async (itx: any): Promise<string[]> => (await itx.rpcStubs.list()) as string[];
/** How many `subscription-configured` events the durable log holds for `name` — the "an identical
 *  re-subscribe appends NOTHING" instrument. */
const configuredEventsFor = async (itx: any, name: string): Promise<number> =>
  (await readAll(itx)).filter((e) => e.type === CONFIGURED && e.payload?.name === name).length;
const haltFactsFor = async (itx: any, name: string): Promise<any[]> =>
  (await readAll(itx)).filter((e) => e.type === HALTED && e.payload?.name === name);

// Client-side sessions retained for the whole file so nothing disposes a parked callback while
// a test still needs it (a live subscriber's transport dies with its providing session).
const keep: unknown[] = [];

// ── the CURSOR-LANE rig: a stateless project worker whose deliveries land in this process ──

/** The stateless "project worker" shape whose progress THE STREAM must keep (a Worker-Loader
 *  entrypoint cannot own it): its `processEventBatch(events, range)` hands the batch to a LIVE hook
 *  the test mounted at `itx.<hook>`, so the collector sees exactly what the cursor lane delivered
 *  (offsets, ranges, attempts) and a hook that throws makes the awaited delivery FAIL — a plain
 *  throw, the ladder's case (the never-retryable case is the `digest` fixture's poison). Source is
 *  kv like every other loaded module (e2e/support/sources.ts). */
const HOOKED_SOURCE = (hook: string) => `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Hooked extends WorkerEntrypoint {
  async processEventBatch(events, range) {
    const itx = await this.env.ITX.get();
    return await itx.${hook}.deliver(events, range);
  }
}`;
class Hook extends RpcTarget {
  readonly #fn: (events: any[], range: Range) => unknown;
  constructor(fn: (events: any[], range: Range) => unknown) {
    super();
    this.#fn = fn;
  }
  deliver(events: any[], range: Range): unknown {
    return this.#fn(events, range);
  }
}
/** Subscribe `name` on the CURSOR lane: park the live hook at `itx.<name>Hook`, seed + mount the
 *  hooked worker at `itx.<name>Worker`, subscribe its `processEventBatch` BY EXPRESSION (an
 *  entrypoint handle ⇒ the stream keeps the cursor). Names are one JS identifier. */
async function cursorSubscribe(
  itx: any,
  name: string,
  fn: (events: any[], range: Range) => unknown,
  consumes?: string[],
): Promise<void> {
  const hook = `${name}Hook`;
  await itx.provide(`itx.${hook}`, new Hook(fn));
  await itx.invokeCapability(["itx", "kv", ["put", `src/${hook}.js`, HOOKED_SOURCE(hook)]]);
  await itx.provide(
    `itx.${name}Worker`,
    `itx.load("itx.kv.get('src/${hook}.js')").getEntrypoint()`,
  );
  await itx.subscribe({
    name,
    target: `itx.${name}Worker.processEventBatch`,
    ...(consumes && { consumes }),
  });
}
/** The `digest` fixture (e2e/support/sources.ts) on the cursor lane: counts delivered events into
 *  kv `digested`; a `payload.poison` mark makes it throw `retryable: false` — the halt-NOW case. */
async function digestSubscribe(itx: any, name: string, consumes?: string[]): Promise<void> {
  await seedSources(itx, ["digest"]);
  await itx.provide("itx.digest", `itx.load("itx.kv.get('src/digest.js')").getEntrypoint()`);
  await itx.subscribe({
    name,
    target: "itx.digest.processEventBatch",
    ...(consumes && { consumes }),
  });
}
const digested = async (itx: any): Promise<number> =>
  Number((await itx.invokeCapability(["itx", "kv", ["get", "digested"]])) ?? 0);
/** Run a cursor-lane scenario and ALWAYS unsubscribe its rows afterwards — a removed row stops its
 *  pump, so one test's deliveries (a ladder retry, a held delivery) never outlive the test. */
async function withCursorRows(itx: any, names: string[], body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } finally {
    for (const name of names) await itx.unsubscribe(name).catch(() => undefined);
  }
}

// ─────────────────────────────── PUSH: a live callback owns its progress ───────────────────────────────

test("push: delivered ranges CHAIN across a consumes-filtered quiet gap", async () => {
  const itx = await harness.itx("prj_fd_chain");
  const c = collector();
  await itx.subscribe({ name: "chain", consumes: ["hit"], target: c.fn });
  const [hit1] = await append(itx, { type: "hit" });
  await until("first delivery", () => c.invocations.length >= 1);
  // five durable non-matching events — a quiet gap the subscriber's filter skips entirely
  for (let i = 0; i < 5; i++) await append(itx, { type: "miss", payload: { i } });
  const [hit2] = await append(itx, { type: "hit" });
  await until("second delivery", () => c.invocations.length >= 2);
  await settle(300);
  expect(c.invocations.length).toBe(2); // the misses must produce NO empty sends
  const [d1, d2] = c.invocations;
  expect(d1.events.map((e) => e.offset)).toEqual([hit1.offset]);
  expect(d2.events.map((e) => e.offset)).toEqual([hit2.offset]);
  // THE contract: the skipped span rides the next delivered range — d2 starts EXACTLY where d1
  // ended (one comparison client-side; a gap here would force a pull that must not be needed).
  expect(d2.range.after).toBe(d1.range.through);
  expect(d2.range.through).toBe(hit2.offset);
});

test("push: consumes naming an ephemeral type opts in; the consumes-less default excludes ephemerals", async () => {
  const itx = await harness.itx("prj_fd_eph");
  const optedIn = collector(); // names the ephemeral type — must receive it
  const dflt = collector(); // no consumes — durable events only
  await itx.subscribe({ name: "opted-in", consumes: ["chunk"], target: optedIn.fn });
  await itx.subscribe({ name: "default", target: dflt.fn });
  const [chunk] = await append(itx, { type: "chunk", ephemeral: true, payload: { n: 1 } });
  const [note] = await append(itx, { type: "note" });
  await until("opted-in got the ephemeral", () => optedIn.offsets().includes(chunk.offset));
  await until("default got the durable", () => dflt.offsets().includes(note.offset));
  await settle(300);
  // the filter is exact (the ONE consumes rule, consumesEvent): the opted-in row saw ONLY its
  // named type; the default row NEVER saw the ephemeral (ephemerals must be named to be delivered)
  expect(optedIn.types()).toEqual(["chunk"]);
  expect(dflt.types()).not.toContain("chunk");
});

test("FIXED (defect 10): consumes ['*'] delivers every durable event to a push target", async () => {
  // WAS-BUG: the connected lane filtered with `row.consumes.includes(e.type)` — "*" was a literal
  //   type name and matched nothing: a silently-dead subscription with no error anywhere.
  // NOW: one rule for every target — `consumesEvent` (stream/processor.ts): "*" = every durable event.
  const itx = await harness.itx("prj_fd_star_conn");
  const star = collector();
  const control = collector();
  await itx.subscribe({ name: "star", consumes: ["*"], target: star.fn });
  await itx.subscribe({ name: "control", consumes: ["note"], target: control.fn });
  const [note] = await append(itx, { type: "note" });
  await until("control got it (the lane works)", () => control.offsets().includes(note.offset));
  await settle(400);
  expect(star.offsets()).toContain(note.offset);
});

test("push: unsubscribe stops deliveries at the removal offset", async () => {
  const itx = await harness.itx("prj_fd_bye");
  const c = collector();
  await itx.subscribe({ name: "bye", consumes: ["mark"], target: c.fn });
  const [m1] = await append(itx, { type: "mark" });
  const [m2] = await append(itx, { type: "mark" });
  await until("both pre-removal marks", () => c.offsets().length >= 2);
  await itx.unsubscribe("bye");
  await append(itx, { type: "mark" });
  await append(itx, { type: "mark" });
  await settle(600);
  // nothing at or beyond the removal offset may arrive — the row died inside the removal commit
  expect([...c.offsets()].sort((a, b) => a - b)).toEqual([m1.offset, m2.offset]);
  expect(await row(itx, "bye")).toBeNull();
});

test("push: re-subscribing the same name REPLACES — the old callback's transport is dropped and it stops receiving; the log does not grow", async () => {
  const itx = await harness.itx("prj_fd_shadow");
  const a = collector();
  const b = collector();
  await itx.subscribe({ name: "dup", consumes: ["mark"], target: a.fn });
  const configuredBefore = await configuredEventsFor(itx, "dup");
  await itx.subscribe({ name: "dup", consumes: ["mark"], target: b.fn }); // replaces a's transport
  const [m] = await append(itx, { type: "mark" });
  await until("the replacing callback delivered", () => b.offsets().includes(m.offset));
  await settle(400);
  expect(b.offsets()).toEqual([m.offset]);
  // the replaced callback is dead for delivery: the re-subscribe re-parked under the SAME key
  // (`itx.subscriptions.dup` — the session's Parking disposes the incumbent relay, and the DO
  // drops the old transport "replaced" when the new pager opens), so a's stub has no transport left
  expect(a.offsets()).toEqual([]);
  // ...and the ROW was untouched: same name, same target `itx.rpcStubs.get('itx.subscriptions.dup')`,
  // same consumes ⇒ the configure door found its own identical row and appended NOTHING — one row
  // for the name (there is no shadow stack: same name REPLACES), the log unchanged.
  expect(await configuredEventsFor(itx, "dup")).toBe(configuredBefore);
  const dup = await row(itx, "dup");
  expect(dup.target).toBe("itx.rpcStubs.get('itx.subscriptions.dup')");
  expect(dup.cursor).toBeUndefined(); // a push target: the client owns its offset
  expect((await rows(itx)).filter((r) => r.name === "dup")).toHaveLength(1);
  expect((await presence(itx)).filter((k) => k === "itx.subscriptions.dup")).toHaveLength(1);
});

test("push: a throwing subscriber callback never hurts the producer and is never retried", async () => {
  const itx = await harness.itx("prj_fd_thrower");
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
  await settle(700); // a retry storm would keep incrementing
  expect(throws).toBe(2); // exactly one offer per batch — fire-and-forget means no ladder here
  expect([...witness.offsets()].sort((a, b) => a - b)).toEqual([m1.offset, m2.offset]);
  expect((await row(itx, "thrower")).cursor).toBeUndefined(); // no cursor, so nothing to halt
});

// ─────────────────────────────── CURSOR: the stream keeps the offset ───────────────────────────────

// FIXED (cursor ack, 2026-09-01): a cursor subscription's FIRST delivery used to redeliver in a hot
// loop (~800/s, measured here) — the row was not seeded before the first call, so the generation
// check read "no row" as "removed" and looped without acking; the halt path sat behind the same
// check. The cursor is now born in memory at `configuredAtOffset` before the first call. Every test
// in this section drove that fix; `withCursorRows` still removes its rows afterwards (hygiene: a
// removed row stops its pump, so one test's traffic never outlives it).

test("cursor: consumes ['*'] delivers every durable event; the row carries a cursor at `through` with the ladder idle", async () => {
  const itx = await harness.itx("prj_fd_star_cur");
  const star = collector();
  const control = collector();
  await withCursorRows(itx, ["star", "control"], async () => {
    await cursorSubscribe(itx, "star", star.fn, ["*"]);
    await cursorSubscribe(itx, "control", control.fn, ["note"]);
    const [note] = await append(itx, { type: "note" });
    await until(
      "control got it (the lane works)",
      () => control.offsets().includes(note.offset),
      8_000,
    );
    await until("star got it", () => star.offsets().includes(note.offset), 8_000);
    await settle(500);
    expect(control.offsets()).toEqual([note.offset]); // exactly once — the awaited call was the ack
    expect(star.offsets().filter((o) => o === note.offset)).toHaveLength(1);
    // the stream keeps their cursors: at/after the note, attempt 0, no retry armed, not halted
    for (const name of ["star", "control"]) {
      const r = await until(
        `${name} row confirmed past the note`,
        async () => {
          const r = await row(itx, name);
          return r?.cursor && r.cursor.confirmedOffset >= note.offset ? r : undefined;
        },
        8_000,
      );
      expect(r.cursor.attempt).toBe(0);
      expect(r.cursor.nextAttemptAtMs).toBeUndefined();
      expect(r.halted).toBeUndefined();
    }
  });
});

test("cursor: ephemerals DO reach a caught-up cursor target (they ride the pushed batch, never the log) — including a FRESH row's first batch after unrelated commits", async () => {
  // (Replaces the deleted "ephemerals never deliver to absent targets" pin: the old forwarder read
  // DURABLE rows only. The one loop remembers the freshest pushed batch per cursor subscription and
  // hands it over when the cursor is contiguous with it — so a caught-up cursor target sees the
  // ephemerals it named; only a target that is BEHIND (repairing from the log) misses them.)
  // BUG (subscription-delivery.ts onCommit): a FRESH row's first delivered range starts at
  //   `#deliveredThrough.get(name) ?? scannedAfterOffset` — the watermark is unset until the first
  //   delivery, so `after` is the CURRENT commit's scannedAfterOffset. Any filtered commit between
  //   the configuration and the first consumed batch (an unrelated event; in practice the
  //   subscriber's own `rpc-stub/attached` presence ephemeral landing a beat after subscribe) moves
  //   it past `configuredAtOffset`, so #pump finds `pushed.after !== row.confirmedOffset`, treats the
  //   caught-up row as BEHIND, reads the log instead — and the ephemerals in that first batch are
  //   silently dropped (durables still arrive, from the log).
  // EXPECTED: "caught up" means no CONSUMED event is outstanding; the first pushed batch is
  //   contiguous with a fresh row, ephemerals included. Candidate fix: seed the watermark at the
  //   configured commit — onCommit already walks `fresh` for `subscription-removed`; on a
  //   `subscription-configured` set `#deliveredThrough[name] = event.offset` (the post-eviction
  //   fallback stays `scannedAfterOffset`, where "behind" is honest).
  // ACTUAL: the ephemeral blip never reaches the hooked worker; the cursor confirms past it from an
  //   empty log page.
  // WHY IT MATTERS: a stateless worker that names an ephemeral type (voice chunks, presence) loses
  //   the first batch after every subscribe whenever anything else committed in between — the
  //   design's one ephemeral promise for cursor targets, broken exactly at the start.
  const itx = await harness.itx("prj_fd_eph_cur");
  const c = collector();
  await withCursorRows(itx, ["ephcur"], async () => {
    await cursorSubscribe(itx, "ephcur", c.fn, ["blip"]);
    await append(itx, { type: "unrelated" }); // a filtered durable commit — the row is still caught up
    const [eph] = await append(itx, { type: "blip", ephemeral: true, payload: { kind: "eph" } });
    await until("the ephemeral blip delivers", () => c.offsets().includes(eph.offset), 8_000);
    const [durable] = await append(itx, { type: "blip", payload: { kind: "durable" } });
    await until("the durable blip delivers", () => c.offsets().includes(durable.offset), 8_000);
    await settle(400);
    expect(c.offsets()).toEqual([eph.offset, durable.offset]); // both, once each, in order
    // ranges chain across the two deliveries exactly like a push subscriber's
    expect(c.invocations[1].range.after).toBe(c.invocations[0].range.through);
    // the cursor stands at the durable head (an ephemeral-only batch advances it in memory only)
    expect((await row(itx, "ephcur")).cursor.confirmedOffset).toBe(durable.offset);
  });
});

test("cursor: retryable:false HALTS after exactly ONE attempt, leaves the halted FACT, marks the row, and stays halted under fresh traffic", async () => {
  // (Replaces the deleted `maxAttempts: 1` pin: there is no knob — the ladder is fixed at 15; the
  // one way to halt NOW is the stamped flag, honored over an invented taxonomy.)
  const itx = await harness.itx("prj_fd_halt");
  await withCursorRows(itx, ["digest"], async () => {
    await digestSubscribe(itx, "digest", ["mark"]);
    const [good] = await append(itx, { type: "mark" });
    await until("the good mark digested", async () => (await digested(itx)) === 1, 8_000);
    const [poison] = await append(itx, { type: "mark", payload: { poison: true } });
    const halted = await until("row halted", async () => (await row(itx, "digest"))?.halted, 8_000);
    expect(halted.attempts).toBe(1); // retryable: false → one attempt, not fifteen
    expect(halted.error).toMatch(/poison/);
    expect(halted.afterOffset).toBeGreaterThanOrEqual(good.offset); // the cursor stood after the good mark…
    expect(halted.afterOffset).toBeLessThan(poison.offset); // …and before the poison
    const facts = await haltFactsFor(itx, "digest");
    expect(facts).toHaveLength(1); // exactly one audit fact
    expect(facts[0].payload).toMatchObject({
      name: "digest",
      attempts: 1,
      afterOffset: halted.afterOffset,
    });
    await append(itx, { type: "mark" }); // fresh traffic must not resurrect a halted row
    await settle(1_200);
    expect(await digested(itx)).toBe(1); // nothing more was delivered
    expect(await haltFactsFor(itx, "digest")).toHaveLength(1);
  });
});

test("cursor: a plain throw climbs the ladder on the DO's alarm — attempt 1 with a retry armed, redelivered within seconds, attempt back to 0", async () => {
  const itx = await harness.itx("prj_fd_ladder");
  let calls = 0;
  const c = collector();
  await withCursorRows(itx, ["ladder"], async () => {
    await cursorSubscribe(
      itx,
      "ladder",
      (events, range) => {
        if (++calls === 1) throw new Error("target down for the first delivery");
        c.fn(events, range);
      },
      ["mark"],
    );
    const [m1] = await append(itx, { type: "mark" });
    // delivery #1 throws (a plain Error — retryable) → attempt 1, the next try armed on the alarm
    const backingOff = await until(
      "ladder step",
      async () => {
        const r = await row(itx, "ladder");
        return r?.cursor && r.cursor.attempt >= 1 ? r : undefined;
      },
      8_000,
    );
    expect(backingOff.cursor.nextAttemptAtMs).toBeGreaterThan(Date.now() - 5_000);
    expect(backingOff.halted).toBeUndefined();
    // ~1s later the alarm pumps: the SAME batch redelivers and the ladder resets
    await until("redelivered", () => c.offsets().includes(m1.offset), 8_000);
    expect(calls).toBe(2);
    const healed = await until(
      "ladder reset",
      async () => {
        const r = await row(itx, "ladder");
        return r?.cursor && r.cursor.attempt === 0 && r.cursor.confirmedOffset >= m1.offset
          ? r
          : undefined;
      },
      8_000,
    );
    expect(healed.cursor.nextAttemptAtMs).toBeUndefined();
    expect(await haltFactsFor(itx, "ladder")).toEqual([]); // the ladder is not a halt
  });
});

test("the view: a push target's row has NO cursor; a resumed fact for an unknown name commits and changes nothing", async () => {
  // (Replaces the deleted "resume errors are loud" pin: `resumeSubscription` is gone. Recovery is a
  // plain append of `subscription-delivery-resumed`; the reduce ignores a name it has no row for.)
  const itx = await harness.itx("prj_fd_view");
  const c = collector();
  await itx.subscribe({ name: "conny", consumes: ["mark"], target: c.fn });
  const before = await rows(itx);
  expect(before).toHaveLength(1);
  expect(before[0].cursor).toBeUndefined();
  const [fact] = await append(itx, { type: RESUMED, payload: { name: "never-was" } });
  expect(fact.offset).toBeGreaterThan(0); // the append is not refused — it is just a fact nobody reduces into a row
  expect(await rows(itx)).toEqual(before);
  expect(await row(itx, "never-was")).toBeNull();
});

test("cursor: a resumed { afterOffset } while HEALTHY redelivers exactly the events after afterOffset (cursor surgery), applied at the row's next pump", async () => {
  const itx = await harness.itx("prj_fd_replay");
  const c = collector();
  await withCursorRows(itx, ["replay"], async () => {
    await cursorSubscribe(itx, "replay", c.fn, ["mark"]);
    const [m1] = await append(itx, { type: "mark", payload: { n: 1 } });
    const [m2] = await append(itx, { type: "mark", payload: { n: 2 } });
    const [m3] = await append(itx, { type: "mark", payload: { n: 3 } });
    await until("first wave", () => c.offsets().length >= 3, 8_000);
    expect([...c.offsets()].sort((a, b) => a - b)).toEqual([m1.offset, m2.offset, m3.offset]);
    const before = c.invocations.length;
    // The operator's ONE recovery event — a plain append. It is level-triggered onto the cursor
    // row: the pump applies it the next time it runs for this row (the next consumed commit, or
    // the DO's alarm) — the resumed event itself is not a "mark", so m4 is that trigger.
    await append(itx, { type: RESUMED, payload: { name: "replay", afterOffset: m1.offset } });
    const [m4] = await append(itx, { type: "mark", payload: { n: 4 } });
    await until("redelivery", () => c.offsets().includes(m4.offset), 8_000);
    await settle(400);
    const redelivered = c.invocations.slice(before).flatMap((i) => i.events.map((e) => e.offset));
    // exactly-from-afterOffset: m2 and m3 once more, then m4; m1 (== afterOffset) NEVER redelivered
    expect(redelivered).toEqual([m2.offset, m3.offset, m4.offset]);
    // and the redelivered range starts surgically at the requested cursor
    expect(c.invocations[before].range.after).toBe(m1.offset);
    const r = await row(itx, "replay");
    expect(r.cursor.confirmedOffset).toBeGreaterThanOrEqual(m4.offset);
    expect(r.halted).toBeUndefined();
  });
});

test("cursor: a resumed afterOffset BEYOND head must not deaden the row — the next appended event still delivers", async () => {
  // BUG: the cursor lane stores a resumed `afterOffset` verbatim. #pump then reads
  //   `read(confirmedOffset, 100)`, whose `scannedThroughOffset` is ≤ head (event-log pin), so with
  //   confirmedOffset > head the page reports "caught up" FOREVER while real events commit at
  //   offsets below the cursor; the pushed batch never matches either (`pushed.after !== cursor`).
  //   The old forwarder had exactly this defect (13) and clamped; the re-homed lane does not.
  // EXPECTED: an over-shot afterOffset clamps to the head (or the reduce refuses it loudly) —
  //   either way the NEXT appended event must deliver.
  // ACTUAL: every event appended after the resume lands below the parked cursor and is silently
  //   skipped until the stream organically burns past the overshoot (1000 offsets here).
  // WHY IT MATTERS: `subscription-delivery-resumed` is THE operator recovery event; a fat-fingered
  //   afterOffset during an incident converts a recoverable row into a silently dead one with no
  //   error and no fact.
  const itx = await harness.itx("prj_fd_beyond");
  const c = collector();
  await withCursorRows(itx, ["beyond"], async () => {
    await cursorSubscribe(itx, "beyond", c.fn, ["mark"]);
    const [m1] = await append(itx, { type: "mark", payload: { n: 1 } });
    await until("lane works", () => c.offsets().includes(m1.offset), 8_000);
    await append(itx, {
      type: RESUMED,
      payload: { name: "beyond", afterOffset: m1.offset + 1000 },
    });
    const [m2] = await append(itx, { type: "mark", payload: { n: 2 } });
    await until(
      "the event after the resume delivers",
      () => c.offsets().includes(m2.offset),
      5_000,
    );
  });
});

test("FIXED (defect 12): unsubscribe during an in-flight delivery leaves no ghost halt and no resurrected cursor", async () => {
  // WAS-BUG: the forwarder's in-flight delivery re-put a revoked row's progress record and then
  //   tried to deliver the revoke fact itself, halting a cleanly unsubscribed row with a false
  //   alarm. NOW: the removal is reduced inline and `forget(name)` drops the cursor; the in-flight
  //   delivery's generation check sees the row is gone and yields — nothing is written, nothing
  //   is appended.
  const itx = await harness.itx("prj_fd_ghost");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let invocations = 0;
  await withCursorRows(itx, ["ghost"], async () => {
    await cursorSubscribe(
      itx,
      "ghost",
      async () => {
        invocations++;
        await gate; // hold THIS delivery in flight while the row is removed underneath it
      },
      ["mark"],
    );
    await append(itx, { type: "mark" });
    await until("delivery in flight", () => invocations >= 1, 8_000);
    await itx.unsubscribe("ghost"); // reduced inline: on return the row is gone and its cursor forgotten
    expect(await row(itx, "ghost")).toBeNull();
    release();
    // correct behavior: the removed row goes quiet — poll generously for the spurious fact
    let haltEvent: any;
    const t0 = Date.now();
    while (Date.now() - t0 < 4_000 && !haltEvent) {
      [haltEvent] = await haltFactsFor(itx, "ghost");
      if (!haltEvent) await settle(150);
    }
    expect(invocations).toBe(1); // the callback itself was never re-offered (sanity)
    expect(haltEvent).toBeUndefined(); // and no halt fact may exist for a removed row
    expect(await row(itx, "ghost")).toBeNull(); // no resurrected row or cursor
  });
});

test("cursor: row isolation — one halted row never blocks its neighbor", async () => {
  const itx = await harness.itx("prj_fd_iso");
  const good = collector();
  await withCursorRows(itx, ["bad", "good"], async () => {
    await digestSubscribe(itx, "bad", ["mark"]); // halts NOW on the poison (retryable: false)
    await cursorSubscribe(itx, "good", good.fn, ["mark"]);
    const [m1] = await append(itx, { type: "mark", payload: { poison: true, n: 1 } });
    await until("bad halted", async () => (await row(itx, "bad"))?.halted, 8_000);
    await until("good got m1", () => good.offsets().includes(m1.offset), 8_000);
    const [m2] = await append(itx, { type: "mark", payload: { n: 2 } });
    await until(
      "good keeps delivering AFTER the neighbor halted",
      () => good.offsets().includes(m2.offset),
      8_000,
    );
    expect((await row(itx, "bad")).halted.attempts).toBe(1);
    expect((await row(itx, "good")).halted).toBeUndefined();
    expect(await digested(itx)).toBe(0); // bad never digested anything: the poison was its first batch
    expect([...good.offsets()].sort((a, b) => a - b)).toEqual([m1.offset, m2.offset]); // no dups
  });
});

test("there is no forwarder: cursor subscriptions enable no processor and mint no facet; a row appears per name, cursor-less until a delivery", async () => {
  // (Replaces the deleted "forwarder auto-enables exactly once" pin: the cursor lane is kernel code
  // in the DO over its own kv and alarm — nothing to auto-enable, nothing to list as a processor.)
  const itx = await harness.itx("prj_fd_auto");
  await Promise.all(
    [1, 2, 3].map((i) =>
      itx.subscribe({
        name: `auto-${i}`,
        target: `itx.sink${i}.processEventBatch`,
        consumes: ["never"],
      }),
    ),
  );
  const listed = await rows(itx);
  expect(listed.map((r) => r.name).sort()).toEqual(["auto-1", "auto-2", "auto-3"]);
  for (const r of listed) {
    expect(r.cursor).toBeUndefined(); // nothing consumed yet ⇒ nothing delivered ⇒ no cursor row
    expect(r.halted).toBeUndefined();
  }
  await expect(
    itx.invokeCapability("itx.facets.get('subscription-forwarder').snapshot()"),
  ).rejects.toThrow(/no facet/);
  // and the subscriptions table's own snapshot is the same truth, as reduced state
  const snap: any = await itx.invokeCapability("itx.facets.get('subscriptions').snapshot()");
  expect(Object.keys(snap.state.subscriptions).sort()).toEqual(["auto-1", "auto-2", "auto-3"]);
});

// (Deleted with live-state MODE: `subscribe({ liveState: { key } })` no longer exists — a tab
// subscribes `consumes: ["events.iterate.com/live-state/changed"]` and filters `payload.key`
// client-side; pinned in live-state-runtime.test.ts and failing-wave2-sweep.test.ts.)

// ─────────────────────────────── BOTH KINDS + PATHOLOGICAL ───────────────────────────────

test("agreement: a push subscriber and a cursor subscriber see the SAME offsets in order", async () => {
  const itx = await harness.itx("prj_fd_lanes");
  const pushed = collector();
  const cursored = collector();
  await withCursorRows(itx, ["viaCursor"], async () => {
    await itx.subscribe({ name: "via-push", consumes: ["mark"], target: pushed.fn });
    await cursorSubscribe(itx, "viaCursor", cursored.fn, ["mark"]);
    const committed: any[] = [];
    for (let i = 0; i < 5; i++)
      committed.push(...(await append(itx, { type: "mark", payload: { i } })));
    const offsets = committed.map((e) => e.offset);
    await until(
      "both done",
      () => pushed.offsets().length >= 5 && cursored.offsets().length >= 5,
      8_000,
    );
    await settle(400);
    expect([...pushed.offsets()].sort((a, b) => a - b)).toEqual(offsets);
    expect([...cursored.offsets()].sort((a, b) => a - b)).toEqual(offsets); // exactly once each
    // within every single delivery, offsets ascend (batch order is log order for both kinds)
    for (const side of [pushed, cursored])
      for (const inv of side.invocations) {
        const off = inv.events.map((e) => e.offset);
        expect(off).toEqual([...off].sort((a, b) => a - b));
      }
  });
});

test("PATHOLOGICAL: 200 push subscribers — one append fans out to all 200 in under 2s", async () => {
  const itx = await harness.itx("prj_fd_fanout");
  const counts = new Array(200).fill(0);
  let received = 0;
  // consumes:["ping"] keeps the 200 setup subscribes from fanning out N² deliveries
  for (let base = 0; base < 200; base += 25) {
    await Promise.all(
      Array.from({ length: Math.min(25, 200 - base) }, (_, j) => {
        const i = base + j;
        return itx.subscribe({
          name: `fan-${i}`,
          consumes: ["ping"],
          target: () => {
            counts[i]++;
            received++;
          },
        });
      }),
    );
  }
  // warm ping: pages all 200 stubs in (cold materialization is not the fan-out cost)
  const tWarm = Date.now();
  await append(itx, { type: "ping", payload: { round: 1 } });
  await until("warm round complete", () => received >= 200, 30_000, 10);
  const coldWallMs = Date.now() - tWarm;
  // the measured round: steady-state fan-out of ONE append across 200 subscribers
  const t0 = Date.now();
  await append(itx, { type: "ping", payload: { round: 2 } });
  await until("all 200 received round 2", () => received >= 400, 10_000, 10);
  const wallMs = Date.now() - t0;
  console.log(`fan-out: cold(first-page) ${coldWallMs}ms, warm ${wallMs}ms for 200 subscribers`);
  expect(wallMs).toBeLessThan(2_000);
  await settle(300);
  expect(counts.every((c) => c === 2)).toBe(true); // exactly once per round, no dup fan-out
}, 120_000);

test("an append of 900 events in one batch arrives as ONE callback invocation (batch preserved)", async () => {
  const itx = await harness.itx("prj_fd_bigbatch");
  const c = collector();
  await itx.subscribe({ name: "bulk", consumes: ["bulk"], target: c.fn });
  const batch = Array.from({ length: 900 }, (_, i) => ({ type: "bulk", payload: { i } }));
  const committed = await append(itx, ...batch);
  expect(committed).toHaveLength(900);
  await until("all 900 delivered", () => c.offsets().length >= 900, 30_000);
  expect(c.invocations).toHaveLength(1); // ONE commit = ONE delivery — the batch is never split
  expect(c.invocations[0].events).toHaveLength(900);
  expect(c.invocations[0].range.through).toBe(committed[899].offset);
});

// ─────────────────────────────── SOCKET-BUFFER OVERFLOW ───────────────────────────────

/** A WebSocket client whose raw TCP socket we can STOP READING (the browser/undici WebSocket hides
 *  it): the `ws` package, resolved through wrangler's dependency tree because this package keeps no
 *  direct dep on it. Pausing `_socket` closes the TCP window, so every server→client send buffers
 *  inside workerd — the client-controllable choke point of the delivery transport. capnweb interops
 *  with a `ws` WebSocket directly (its transport needs only binaryType/readyState/
 *  addEventListener/send, and `ws` speaks all four). */
type StallableWebSocket = {
  _socket: { pause(): void; resume(): void };
  readyState: number;
  send(data: string): void;
  close(): void;
  /** Hard TCP destroy — no close handshake (which a paused peer could never read anyway). */
  terminate(): void;
  addEventListener(type: string, fn: (ev: unknown) => void): void;
};
function stallableWebSocket(url: string): StallableWebSocket {
  const req = createRequire(import.meta.url);
  const wranglerDir = dirname(req.resolve("wrangler/package.json"));
  const { WebSocket: WsWebSocket } = req(req.resolve("ws", { paths: [wranglerDir] }));
  return new WsWebSocket(url) as StallableWebSocket;
}

test("MEASURED FINDING: a push subscriber that stops reading mid-flood is NOT closed by local workerd (≥60MiB buffers silently) — but a real socket close drops its stub instantly; the ROW stays until unsubscribe", async () => {
  // The loop's design comment (subscription-delivery.ts): a push is fire-and-forget; the socket
  // buffer is the only queue. This test ran that claim to ground against local workerd. It is NOT
  // a test.fails: the buffering policy is workerd's, not this codebase's — what IS ours (close →
  // onRpcBroken → pager close → the DO drops the transport → `itx.rpcStubs.list()` stops listing
  // the key, while the ROW stays in the subscriptions table and pushes to it are swallowed as
  // CONNECTION_OFFLINE) is proven live below.
  // EXPECTED (design): a client that stops reading its /api socket eventually overflows the
  //   server's send buffer; workerd closes the socket; the relay's onRpcBroken closes the stub
  //   pager; the DO drops the transport (presence shrinks). Nothing touches the subscriptions
  //   table — a row is data, never a liveness claim.
  // ACTUAL (measured, local workerd via wrangler createTestHarness): 60.0MiB of payload flooded
  //   into a TCP-paused subscriber produced NO close, NO delivery.push.dropped warn, NO
  //   CONNECTION_OFFLINE — the stub stayed present and the row stayed listed. workerd buffers
  //   the outgoing WebSocket without any local limit we could reach. The chain itself is sound:
  //   hard-killing the stalled socket dropped the stub from presence in 10–30ms.
  // RESIDUAL: live Cloudflare is NOT proven either way here — real edge sockets have real buffer
  //   limits, so the overflow-close half may well hold in production; this pin documents LOCAL
  //   workerd only. If the still-present assertion below ever fails, workerd grew a send-buffer
  //   limit — upgrade this pin to assert the overflow-close instead.
  const ctx = "prj_fd_overflow";
  const itx = await harness.itx(ctx); // connection A: setup, the flood, and observation
  // Connection B — THE VICTIM: its own client socket, because the retained callback stub lives in
  // that socket's relay session; the socket's death must become the stub's death.
  const wsB = stallableWebSocket(`ws://${harness.url.host}/api`);
  const sessionB: any = newWebSocketRpcSession(wsB as any);
  keep.push(sessionB);
  const victim = sessionB.authenticate().projects.get(ctx);
  const c = collector();
  await victim.subscribe({ name: "victim", consumes: ["flood"], target: c.fn });
  // one probe proves the lane end-to-end BEFORE the stall
  await append(itx, { type: "flood", ephemeral: true, payload: { probe: true } });
  await until("probe delivered over the victim socket", () => c.invocations.length >= 1);
  // the victim's row is a PUSH row (pure data — target `itx.rpcStubs.get('itx.subscriptions.victim')`,
  // no cursor); whether that stub is ONLINE is the registry's fact, read separately (the raw
  // transport count is a DO-only transportState() fact, unreachable from this capnweb lane)
  const victimRow = { name: "victim", target: "itx.rpcStubs.get('itx.subscriptions.victim')" };
  const before = await rows(itx);
  expect(before).toContainEqual(expect.objectContaining(victimRow));
  expect(before.find((r) => r.name === "victim").cursor).toBeUndefined();
  const victimOnline = async () => (await presence(itx)).includes("itx.subscriptions.victim");
  expect(await victimOnline()).toBe(true);
  const droppedWarns = () =>
    (JSON.stringify(harness.logs()).match(/delivery\.push\.dropped/g) ?? []).length;
  const droppedBefore = droppedWarns(); // logs are harness-global — assert the DELTA, not zero

  // THE STALL: stop reading the victim's TCP socket. The kernel recv buffer fills, the TCP window
  // closes, and workerd's sends for this socket can only buffer.
  wsB._socket.pause();

  // THE FLOOD: ephemeral events (memory-only server-side) with chunky payloads, ~0.5MiB per append
  // (two 256KiB events — each hop's message stays under production's 1MiB WebSocket-message cap).
  // Bounded at 60MiB; bail the moment the stub drops from presence (it never did — see ACTUAL).
  const chunk = "x".repeat(256 * 1024);
  let floodedBytes = 0;
  let stubDropped = false;
  for (let i = 0; i < 120 && !stubDropped; i++) {
    await append(
      itx,
      { type: "flood", ephemeral: true, payload: { i, chunk } },
      { type: "flood", ephemeral: true, payload: { i: i + 0.5, chunk } },
    );
    floodedBytes += 2 * chunk.length;
    stubDropped = !(await victimOnline());
  }
  // bounded negative wait: when a close DOES propagate, the drop lands in tens of ms (measured
  // below via the kill) — 1.5s is ample for an overflow-close triggered by the flood to surface.
  if (!stubDropped) {
    const tGrace = Date.now();
    while (Date.now() - tGrace < 1_500 && !stubDropped) {
      stubDropped = !(await victimOnline());
      if (!stubDropped) await settle(150);
    }
  }
  const after = await rows(itx);
  console.log(
    `overflow: flooded ${(floodedBytes / 1024 / 1024).toFixed(1)}MiB into a paused socket; ` +
      `stubDropped=${stubDropped}; dropped-warn delta=${droppedWarns() - droppedBefore}`,
  );
  // THE FINDING, pinned: the full 60MiB went in and NOTHING happened — no close, no stub drop, no
  // dropped-delivery warn. workerd absorbed it all in memory.
  expect(floodedBytes).toBe(120 * 2 * 256 * 1024);
  expect(stubDropped).toBe(false);
  expect(after).toContainEqual(expect.objectContaining(victimRow));
  expect(await victimOnline()).toBe(true);
  expect(droppedWarns() - droppedBefore).toBe(0);

  // THE CHAIN IS SOUND: hard-kill the stalled socket (RST — no close handshake a paused reader
  // could never read) and the stub drop fires end-to-end: relay onRpcBroken → pager close → the
  // DO drops the transport → presence stops listing the key. Measured 10–30ms; the until bound
  // is generous, not a latency pin.
  const tKill = Date.now();
  wsB.terminate();
  await until(
    "stub gone from presence after the socket died",
    async () => !(await victimOnline()),
    15_000,
  );
  console.log(`socket kill → stub dropped from presence in ${Date.now() - tKill}ms`);
  // THE ROW IS DATA: it is still in the table — nothing auto-removes it because a socket died.
  // The producer is unaffected: an append still commits, and the push to the dead stub is
  // swallowed as CONNECTION_OFFLINE (no dropped-delivery warn — offline is the benign case the
  // loop expects, not a drop worth a line).
  expect(await rows(itx)).toContainEqual(expect.objectContaining(victimRow));
  await append(itx, { type: "flood", ephemeral: true, payload: { afterKill: true } });
  await settle(300);
  expect(droppedWarns() - droppedBefore).toBe(0);
  // The explicit exit — unsubscribe from ANY session (here A, which never parked the stub, so its
  // `rpcStubs.close` half is a local no-op; the removal drops the row). The victim was this ctx's
  // only subscription.
  await itx.unsubscribe("victim");
  expect(await rows(itx)).toEqual([]);
}, 55_000);
