// cursor-delivery-halts-ladders-and-resumes.e2e.test.ts — THE CURSOR LANE live. A subscription whose
// target cannot own its progress — a Worker-Loader entrypoint's `processEventBatch(events, range)`,
// the stateless "project worker" — is delivered at-least-once from a cursor THE STREAM keeps
// (`itx.subscriptions.get(name).cursor`): the awaited call is the ack; a plain throw climbs the one
// retry ladder (1s·2ⁿ ≤ 30min, 15 attempts) on the DO's own alarm; `retryable: false` HALTS at once
// with a `subscription-delivery-halted` fact; recovery is the operator's ONE event,
// `subscription-delivery-resumed { name, afterOffset? }` — un-halt, and seek. Nothing is declared:
// the loop evaluates the target and looks at the value (an entrypoint handle ⇒ cursor; a live stub
// or a facet ⇒ push, no cursor). No lanes, no forwarder facet, no policy knobs.

import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import {
  append,
  collector,
  freshCtx,
  openItx,
  readAll,
  readHead,
  sleep,
  subscriptions,
  until,
} from "./support/client.ts";
import { seedSources } from "./support/sources.ts";

const HALTED = "events.iterate.com/stream/subscription-delivery-halted";
const RESUMED = "events.iterate.com/stream/subscription-delivery-resumed";

type Range = { after: number; through: number };
const row = async (itx: any, name: string): Promise<any> => itx.subscriptions.get(name);
const haltFactsFor = async (itx: any, name: string): Promise<any[]> =>
  (await readAll(itx)).filter((e) => e.type === HALTED && e.payload?.name === name);

// ── the HOOKED rig: a stateless project worker whose deliveries land in this process ──

/** The stateless "project worker" shape whose progress THE STREAM must keep (a Worker-Loader
 *  entrypoint cannot own it): its `processEventBatch(events, range)` hands the batch to a LIVE hook
 *  the test mounted at `itx.<hook>`, so a collector sees exactly what the cursor lane delivered
 *  (offsets, ranges, attempts) and a hook that throws makes the awaited delivery FAIL — a plain
 *  throw, the ladder's case (the never-retryable case is the `digest` fixture's poison). */
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
  await itx.kv.put(`src/${hook}.js`, HOOKED_SOURCE(hook));
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
const digested = async (itx: any): Promise<number> => Number((await itx.kv.get("digested")) ?? 0);

// ── the LEDGER rig: a stateless worker that ledgers every delivery into the project's kv ──

/** `ledger:calls` / `ledger:log` (= the delivered offsets per call), so the test observes the cursor
 *  lane from outside without a live callback in the loop. `ctx.props.firstCall` scripts delivery #1:
 *  "throw" (a plain, retryable Error — the ladder) or "hold" (2s in flight — a resume races it). */
const LEDGER_SRC = `import { WorkerEntrypoint } from "cloudflare:workers";
export class Ledger extends WorkerEntrypoint {
  async processEventBatch(events, range) {
    const itx = await this.env.ITX.get();
    const n = Number((await itx.kv.get("ledger:calls")) ?? 0) + 1;
    await itx.kv.put("ledger:calls", String(n));
    if (n === 1 && this.ctx.props.firstCall === "throw")
      throw new Error("ledger: down for the first delivery");
    if (n === 1 && this.ctx.props.firstCall === "hold") await new Promise((r) => setTimeout(r, 2000));
    const log = JSON.parse((await itx.kv.get("ledger:log")) ?? "[]");
    log.push({ range, offsets: events.map((e) => e.offset) });
    await itx.kv.put("ledger:log", JSON.stringify(log));
  }
}`;
type LedgerEntry = { range: Range; offsets: number[] };
const ledgerLog = async (itx: any): Promise<LedgerEntry[]> =>
  JSON.parse(((await itx.kv.get("ledger:log")) as string | null) ?? "[]") as LedgerEntry[];
const mountLedger = async (itx: any, firstCall: "throw" | "hold"): Promise<void> => {
  await itx.kv.put("src/ledger.js", LEDGER_SRC);
  await itx.provide(
    "itx.ledger",
    `itx.load("itx.kv.get('src/ledger.js')").getEntrypoint('Ledger', { props: { firstCall: '${firstCall}' } })`,
  );
  await itx.subscribe({
    name: "ledger",
    target: "itx.ledger.processEventBatch",
    consumes: ["mark"],
  });
};

// ─────────────────────────────── the halt / resume story ───────────────────────────────

test("the digest worker is delivered from a stream-kept cursor; retryable:false halts with the fact; a resumed event un-halts and seeks past the poison", async () => {
  const itx = openItx(freshCtx("cursor"));
  await seedSources(itx, ["digest"]);

  // 1. mount the stateless digest worker and subscribe its processEventBatch BY EXPRESSION — an
  //    entrypoint cannot own its progress, so THE STREAM keeps the cursor. Beside it, a live tab:
  //    a parked stub owns its progress, so its row has NO cursor. Same verb, no declaration.
  await itx.provide("itx.digest", `itx.load("itx.kv.get('src/digest.js')").getEntrypoint()`);
  const sub = await itx.subscribe({
    name: "digest",
    target: "itx.digest.processEventBatch",
    consumes: ["mark"],
  });
  expect(sub.name).toBe("digest"); // subscribe returns the row name
  await itx.subscribe({ name: "tab", target: () => undefined, consumes: ["mark"] });

  // 2. three good marks → the worker's own kv shows 3 (the awaited call IS the ack); the digest row
  //    carries a cursor at or past the last mark with the ladder idle; the tab row carries none
  const marks: { offset: number }[] = [];
  for (let i = 0; i < 3; i++) marks.push((await itx.append({ type: "mark" }))[0]);
  await until("digest=3", async () => (await digested(itx)) === 3, 30_000);
  const row3 = await until("cursor past mark 3", async () => {
    const r = await row(itx, "digest");
    return r?.cursor && r.cursor.confirmedOffset >= marks[2].offset ? r : undefined;
  });
  expect(row3.cursor.attempt).toBe(0);
  expect(row3.halted).toBeUndefined();
  expect(row3.target).toBe("itx.digest.processEventBatch"); // stored as written — an alias classifies by its value
  expect((await row(itx, "tab")).cursor).toBeUndefined(); // push target: the client owns its offset
  expect((await subscriptions(itx)).map((r: { name: string }) => r.name).sort()).toEqual([
    "digest",
    "tab",
  ]);

  // 3. a poison mark: digest stamps `retryable: false`, so the loop HALTS NOW — no ladder burned on
  //    an error that can never succeed (the stamped-flag doctrine, lib/errors.ts) — and appends the
  //    halted FACT; a good mark stuck behind it waits. ONE policy, no skip, no pinning.
  const [poisoned] = await itx.append({ type: "mark", payload: { poison: true } });
  const [stuck] = await itx.append({ type: "mark" });
  const halted = await until("row halted", async () => (await row(itx, "digest"))?.halted, 30_000);
  expect(halted.attempts).toBe(1); // retryable: false → one attempt, not fifteen
  expect(halted.afterOffset).toBeGreaterThanOrEqual(marks[2].offset); // the cursor stood after the good marks…
  expect(halted.afterOffset).toBeLessThan(poisoned.offset); // …and before the poison
  expect(halted.error).toMatch(/poison/);
  const facts = await haltFactsFor(itx, "digest");
  expect(facts).toHaveLength(1); // exactly one audit fact
  expect(facts[0].payload).toMatchObject({
    name: "digest",
    attempts: 1,
    afterOffset: halted.afterOffset,
  });
  expect(await digested(itx)).toBe(3); // halted: nothing more was delivered
  // fresh traffic must not resurrect a halted row: a new mark commits, nothing is delivered, no
  // second halt fact is appended (the loop skips a halted row outright)
  const [fresh] = await itx.append({ type: "mark" });
  await sleep(1_200);
  expect(await digested(itx)).toBe(3);
  expect(await haltFactsFor(itx, "digest")).toHaveLength(1);

  // 4. recovery is ONE operator event, a plain append: resumed { afterOffset: poisoned.offset }
  //    un-halts and seeks the cursor past the poison — and the resumed fact IS the wake: the loop
  //    pumps that name on its commit, whatever the row's `consumes` says. The stuck mark and the
  //    fresh one land on their own (3 → 5): the seek skipped exactly the poison, and at-least-once
  //    delivery resumed.
  await itx.append({ type: RESUMED, payload: { name: "digest", afterOffset: poisoned.offset } });
  await until(
    "digest=5 (resume alone, past the poison)",
    async () => (await digested(itx)) === 5,
    30_000,
  );
  const rowAfter = await row(itx, "digest");
  expect(rowAfter.halted).toBeUndefined();
  expect(rowAfter.cursor.attempt).toBe(0);
  expect(rowAfter.cursor.confirmedOffset).toBeGreaterThanOrEqual(fresh.offset);
  expect(stuck.offset).toBeGreaterThan(poisoned.offset); // the seek landed between the two
  // …and the lane keeps flowing afterwards.
  await itx.append({ type: "mark" });
  await until("digest=6", async () => (await digested(itx)) === 6, 30_000);
});

test("a plain throw climbs the retry ladder on the DO's alarm — redelivered within seconds, attempt back to 0", async () => {
  const itx = openItx(freshCtx("ladder"));
  await mountLedger(itx, "throw");

  const [m1] = await itx.append({ type: "mark", payload: { n: 1 } });
  // delivery #1 throws (a plain Error — retryable) → attempt 1, the next try armed on the alarm
  const backingOff = await until("ladder step", async () => {
    const r = await row(itx, "ledger");
    return r?.cursor && r.cursor.attempt >= 1 ? r : undefined;
  });
  expect(backingOff.cursor.nextAttemptAtMs).toBeGreaterThan(0);
  expect(backingOff.halted).toBeUndefined();

  // the alarm pumps the due row → delivery #2 carries m1 (at-least-once) → the ladder resets
  const log = await until(
    "m1 redelivered by the ladder",
    async () => {
      const l = await ledgerLog(itx);
      return l.some((entry) => entry.offsets.includes(m1.offset)) ? l : undefined;
    },
    20_000,
  );
  expect(log).toHaveLength(1); // the FAILED call ledgered nothing; exactly one successful delivery
  expect(await itx.kv.get("ledger:calls")).toBe("2");
  const settled = await until("ladder reset", async () => {
    const r = await row(itx, "ledger");
    return r?.cursor && r.cursor.attempt === 0 && r.cursor.confirmedOffset >= m1.offset
      ? r
      : undefined;
  });
  expect(settled.cursor.nextAttemptAtMs).toBeUndefined();
  expect(settled.halted).toBeUndefined();
  expect(await haltFactsFor(itx, "ledger")).toEqual([]); // the ladder is not a halt
});

test("a resumed event appended MID-DELIVERY wins — m1 redelivers from the seek, liveness holds", async () => {
  const itx = openItx(freshCtx("racewin"));
  await mountLedger(itx, "hold");

  const [m1] = await itx.append({ type: "mark", payload: { n: 1 } });
  await until("delivery #1 in flight", async () => (await itx.kv.get("ledger:calls")) === "1");
  // the operator seeks to the beginning WHILE delivery #1 is held (2s)
  await itx.append({ type: RESUMED, payload: { name: "ledger", afterOffset: 0 } });

  // delivery #1 completes OK; the resume wins: m1 is delivered AGAIN from the seek
  const redelivered = await until(
    "m1 redelivered after the seek",
    async () => {
      const l = await ledgerLog(itx);
      return l.filter((entry) => entry.offsets.includes(m1.offset)).length >= 2 ? l : undefined;
    },
    20_000,
  );
  expect(redelivered!.at(-1)!.range.after).toBeLessThan(m1.offset); // the redelivery ranges from the seek

  // liveness after the race: a later mark still lands and the cursor moves past it
  const [m2] = await itx.append({ type: "mark", payload: { n: 2 } });
  await until("m2 delivered", async () =>
    (await ledgerLog(itx)).some((entry) => entry.offsets.includes(m2.offset)),
  );
  const r = await row(itx, "ledger");
  expect(r.halted).toBeUndefined();
  expect(r.cursor.attempt).toBe(0);
  expect(r.cursor.confirmedOffset).toBeGreaterThanOrEqual(m2.offset);
});

test("a resumed { afterOffset } while HEALTHY redelivers exactly the events after afterOffset (cursor surgery), applied at the row's next pump", async () => {
  const itx = openItx(freshCtx("replay"));
  const c = collector();
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
  await sleep(400);
  const redelivered = c.invocations.slice(before).flatMap((i) => i.events.map((e) => e.offset));
  // exactly-from-afterOffset: m2 and m3 once more, then m4; m1 (== afterOffset) NEVER redelivered
  expect(redelivered).toEqual([m2.offset, m3.offset, m4.offset]);
  expect(c.invocations[before].range.after).toBe(m1.offset); // the range starts surgically at the cursor
  const r = await row(itx, "replay");
  expect(r.cursor.confirmedOffset).toBeGreaterThanOrEqual(m4.offset);
  expect(r.halted).toBeUndefined();
});

test("a resumed afterOffset BEYOND head must not deaden the row — the next appended event still delivers", async () => {
  // `subscription-delivery-resumed` is THE operator recovery event; a fat-fingered afterOffset
  // during an incident must not convert a recoverable row into a silently dead one.
  const itx = openItx(freshCtx("beyond"));
  const c = collector();
  await cursorSubscribe(itx, "beyond", c.fn, ["mark"]);
  const [m1] = await append(itx, { type: "mark", payload: { n: 1 } });
  await until("lane works", () => c.offsets().includes(m1.offset), 8_000);
  await append(itx, { type: RESUMED, payload: { name: "beyond", afterOffset: m1.offset + 1000 } });
  const [m2] = await append(itx, { type: "mark", payload: { n: 2 } });
  await until("the event after the resume delivers", () => c.offsets().includes(m2.offset), 5_000);
});

test("the view: a push target's row has NO cursor; a resumed fact for an unknown name commits and changes nothing", async () => {
  // Recovery is a plain append of `subscription-delivery-resumed`; the reduce ignores a name it has
  // no row for.
  const itx = openItx(freshCtx("view"));
  const c = collector();
  await itx.subscribe({ name: "conny", consumes: ["mark"], target: c.fn });
  const before = await subscriptions(itx);
  expect(before).toHaveLength(1);
  expect(before[0].cursor).toBeUndefined();
  const [fact] = await append(itx, { type: RESUMED, payload: { name: "never-was" } });
  expect(fact.offset).toBeGreaterThan(0); // not refused — a fact nobody reduces into a row
  expect(await subscriptions(itx)).toEqual(before);
  expect(await row(itx, "never-was")).toBeNull();
});

// ─────────────────────────────── what the cursor lane delivers ───────────────────────────────

test("consumes ['*'] delivers every durable event; the row carries a cursor at `through` with the ladder idle", async () => {
  const itx = openItx(freshCtx("starcur"));
  const star = collector();
  const control = collector();
  await cursorSubscribe(itx, "star", star.fn, ["*"]);
  await cursorSubscribe(itx, "control", control.fn, ["note"]);
  const [note] = await append(itx, { type: "note" });
  await until(
    "control got it (the lane works)",
    () => control.offsets().includes(note.offset),
    8_000,
  );
  await until("star got it", () => star.offsets().includes(note.offset), 8_000);
  await sleep(500);
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

test("ephemerals DO reach a caught-up cursor target (they ride the pushed batch, never the log) — including a FRESH row's first batch after unrelated commits", async () => {
  // The one loop remembers the freshest pushed batch per cursor subscription and hands it over when
  // the cursor is contiguous with it — so a caught-up cursor target sees the ephemerals it named;
  // only a target that is BEHIND (repairing from the log) misses them. "Caught up" means no CONSUMED
  // event is outstanding: a filtered commit between the configuration and the first consumed batch
  // must not make the first batch read "behind".
  const itx = openItx(freshCtx("ephcur"));
  const c = collector();
  await cursorSubscribe(itx, "ephcur", c.fn, ["blip"]);
  await append(itx, { type: "unrelated" }); // a filtered durable commit — the row is still caught up
  const [eph] = await append(itx, { type: "blip", ephemeral: true, payload: { kind: "eph" } });
  await until("the ephemeral blip delivers", () => c.offsets().includes(eph.offset), 8_000);
  const [durable] = await append(itx, { type: "blip", payload: { kind: "durable" } });
  await until("the durable blip delivers", () => c.offsets().includes(durable.offset), 8_000);
  await sleep(400);
  expect(c.offsets()).toEqual([eph.offset, durable.offset]); // both, once each, in order
  // ranges chain across the two deliveries exactly like a push subscriber's
  expect(c.invocations[1].range.after).toBe(c.invocations[0].range.through);
  // the cursor stands at the durable head (an ephemeral-only batch advances it in memory only)
  expect((await row(itx, "ephcur")).cursor.confirmedOffset).toBe(durable.offset);
});

test("unsubscribe during an in-flight delivery leaves no ghost halt and no resurrected cursor", async () => {
  // The removal is reduced inline and `forget(name)` drops the cursor; the in-flight delivery's
  // generation check sees the row is gone and yields — nothing is written, nothing is appended.
  const itx = openItx(freshCtx("ghost"));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let invocations = 0;
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
  // the removed row goes quiet — poll generously for a spurious fact
  let haltEvent: any;
  const t0 = Date.now();
  while (Date.now() - t0 < 4_000 && !haltEvent) {
    [haltEvent] = await haltFactsFor(itx, "ghost");
    if (!haltEvent) await sleep(150);
  }
  expect(invocations).toBe(1); // the callback itself was never re-offered (sanity)
  expect(haltEvent).toBeUndefined(); // no halt fact may exist for a removed row
  expect(await row(itx, "ghost")).toBeNull(); // no resurrected row or cursor
});

test("row isolation — one halted row never blocks its neighbor", async () => {
  const itx = openItx(freshCtx("iso"));
  const good = collector();
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

test("cursor subscriptions enable no processor and mint no facet; a row appears per name, cursor-less until a delivery", async () => {
  // The cursor lane is kernel code in the DO over its own kv and alarm — nothing to auto-enable,
  // nothing to list as a processor.
  const itx = openItx(freshCtx("auto"));
  await Promise.all(
    [1, 2, 3].map((i) =>
      itx.subscribe({
        name: `auto-${i}`,
        target: `itx.sink${i}.processEventBatch`,
        consumes: ["never"],
      }),
    ),
  );
  const listed = await subscriptions(itx);
  expect(listed.map((r) => r.name).sort()).toEqual(["auto-1", "auto-2", "auto-3"]);
  for (const r of listed) {
    expect(r.cursor).toBeUndefined(); // nothing consumed yet ⇒ nothing delivered ⇒ no cursor row
    expect(r.halted).toBeUndefined();
  }
  // and the subscriptions table's own snapshot is the same truth, as reduced state
  const snap: any = await itx.invokeCapability("itx.facets.get('subscriptions').snapshot()");
  expect(Object.keys(snap.state.subscriptions).sort()).toEqual(["auto-1", "auto-2", "auto-3"]);
});

test("subscribe resolves without probing the receiver; an unusable target fails at its FIRST delivery, never at configure", async () => {
  // A deliberate non-guarantee, kept on purpose (apps/os documents the same one): configure appends
  // the row and returns — "the receiver learns about the subscription when its first copy arrives".
  // A fat-fingered target therefore fails LATE: the loop fails to evaluate `itx.does-not-exist` on
  // the first consumed commit (NO_CAPABILITY_MATCH, a reported issue), and — the head never
  // evaluating — the row never grows a cursor and never halts.
  const itx = openItx(freshCtx("noverify"));
  const sub = await itx.subscribe({
    name: "unusable",
    consumes: ["mark"],
    target: "itx.does-not-exist.processEventBatch",
  });
  expect(sub.name).toBe("unusable"); // configure resolved — the receiver was not probed
  await append(itx, { type: "mark" }); // the first delivery fails inside the loop, never here
  await sleep(800);
  const r = await row(itx, "unusable");
  expect(r).not.toBeNull(); // the row stands…
  expect(r.cursor).toBeUndefined(); // …with no cursor (the head never evaluated)…
  expect(r.halted).toBeUndefined(); // …and no halt fact for an operator to find
});

test("agreement: a push subscriber and a cursor subscriber see the SAME offsets in order", async () => {
  const itx = openItx(freshCtx("lanes"));
  const pushed = collector();
  const cursored = collector();
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
  await sleep(400);
  expect([...pushed.offsets()].sort((a, b) => a - b)).toEqual(offsets);
  expect([...cursored.offsets()].sort((a, b) => a - b)).toEqual(offsets); // exactly once each
  // within every single delivery, offsets ascend (batch order is log order for both kinds)
  for (const side of [pushed, cursored])
    for (const inv of side.invocations) {
      const off = inv.events.map((e) => e.offset);
      expect(off).toEqual([...off].sort((a, b) => a - b));
    }
});

test("reentrancy: a cursor delivery targeting this stream's own append neither deadlocks nor runs away — the call shape is refused, the ladder backs off, the stream stays serviceable", async () => {
  // `itx.cd('/').append` is a legal cursor target (a sibling-context handle cannot own its
  // progress) and the delivery call is append(eventsArray, range) — whose first arg is an ARRAY.
  // append's runtime guard refuses it (an array has no string `type`). The ONE ladder (1s·2ⁿ, 15
  // attempts ≈ hours) backs off on the DO's alarm — so within a test the row shows attempt ≥ 1
  // with a retry armed, never a halt. Bounded and loud — no deadlock, no runaway loop, no junk rows.
  const itx = openItx(freshCtx("reenter"));
  const ctrl = collector();
  await itx.subscribe({ name: "ctrl", consumes: ["seed"], target: ctrl.fn });
  // the cursor subscription whose delivery APPENDS BACK into the stream it delivers from
  await itx.subscribe({ name: "reenter", consumes: ["seed"], target: "itx.cd('/').append" });
  const [seed] = await append(itx, { type: "seed", payload: { n: 1 } });
  await until("control subscriber saw the seed", () => ctrl.offsets().includes(seed.offset));

  // no deadlock and no runaway: the head must go QUIET (stable for 2s within 15s)
  let head = await readHead(itx);
  await until(
    "head stable for 2s",
    async () => {
      await sleep(2_000);
      const now = await readHead(itx);
      const stable = now === head;
      head = now;
      return stable;
    },
    15_000,
  );

  const events = await readAll(itx);
  expect(events.filter((e) => typeof e.type !== "string")).toHaveLength(0); // no junk committed
  expect(events.length).toBeLessThan(20); // bounded, whatever branch the platform takes
  const r: any = await row(itx, "reenter");
  expect(r.cursor.attempt).toBeGreaterThanOrEqual(1); // the refused call climbed the ladder…
  expect(r.cursor.nextAttemptAtMs).toBeGreaterThan(0); // …with the next try armed on the alarm
  expect(r.halted).toBeUndefined(); // a plain throw is never a halt
  expect(ctrl.offsets().filter((o) => o === seed.offset)).toHaveLength(1); // seed seen exactly once

  // the stream stays serviceable for later work, and removing the row ends the ladder
  const [post] = await append(itx, { type: "afterparty" });
  expect(post.offset).toBeGreaterThan(seed.offset);
  await itx.unsubscribe("reenter");
  expect(await row(itx, "reenter")).toBeNull();
});
