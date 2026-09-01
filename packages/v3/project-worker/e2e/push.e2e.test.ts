// push.e2e.test.ts — THE CURSOR LANE live. A subscription whose target cannot own its progress — a
// Worker-Loader entrypoint's `processEventBatch(events, range)`, the stateless "project worker" —
// is delivered at-least-once from a cursor THE STREAM keeps: the awaited call is the ack; a plain
// throw climbs the one retry ladder (1s·2ⁿ ≤ 30min, 15 attempts) on the DO's own alarm;
// `retryable: false` HALTS at once with a `subscription-delivery-halted` fact; recovery is the
// operator's ONE event, `subscription-delivery-resumed { name, afterOffset? }` — un-halt, and seek.
// Nothing is declared: the loop evaluates the target and looks at the value (an entrypoint handle ⇒
// cursor; a live stub or a facet ⇒ push, no cursor). No lanes, no forwarder facet, no policy knobs.
// (was proofs/prove_push.mjs; also carries the two still-true pins of the deleted resume-race /
// resume-race-control files — the ladder retries promptly, and a resume landing MID-DELIVERY wins)

import { expect, test } from "vitest";
import { freshCtx, openItx, subscriptions, until } from "./support/client.ts";
import { seedSources } from "./support/sources.ts";

const HALTED = "events.iterate.com/stream/subscription-delivery-halted";
const RESUMED = "events.iterate.com/stream/subscription-delivery-resumed";

/** A stateless worker that LEDGERS every delivery into the project's kv (`ledger:calls`, `ledger:log`
 *  = the delivered offsets per call), so the test observes the cursor lane from outside without a
 *  live callback in the loop. `ctx.props.firstCall` scripts delivery #1: "throw" (a plain, retryable
 *  Error — the ladder) or "hold" (2s in flight — a resume races it). */
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
type LedgerEntry = { range: { after: number; through: number }; offsets: number[] };
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

test("cursor lane: the digest worker is delivered from a stream-kept cursor; retryable:false halts with the fact; a resumed event un-halts and seeks past the poison", async () => {
  const itx = openItx(freshCtx("push"));
  await seedSources(itx, ["digest"]);
  const digested = async (): Promise<string | null> =>
    (await itx.invokeCapability(["itx", "kv", ["get", "digested"]])) as string | null;

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
  await until("digest=3", async () => (await digested()) === "3", 30_000);
  const row3 = await until("cursor past mark 3", async () => {
    const r = await itx.subscriptions.get("digest");
    return r?.cursor && r.cursor.confirmedOffset >= marks[2].offset ? r : undefined;
  });
  expect(row3.cursor.attempt).toBe(0);
  expect(row3.halted).toBeUndefined();
  expect(row3.target).toBe("itx.digest.processEventBatch"); // stored as written — an alias classifies by its value
  expect((await itx.subscriptions.get("tab")).cursor).toBeUndefined(); // push target: the client owns its offset
  expect((await subscriptions(itx)).map((r: { name: string }) => r.name).sort()).toEqual([
    "digest",
    "tab",
  ]);

  // 3. a poison mark: digest stamps `retryable: false`, so the loop HALTS NOW — no ladder burned on
  //    an error that can never succeed (the stamped-flag doctrine, lib/errors.ts) — and appends the
  //    halted FACT; a good mark stuck behind it waits. ONE policy, no skip, no pinning.
  const [poisoned] = await itx.append({ type: "mark", payload: { poison: true } });
  const [stuck] = await itx.append({ type: "mark" });
  const halted = await until(
    "row halted",
    async () => (await itx.subscriptions.get("digest"))?.halted,
    30_000,
  );
  expect(halted.attempts).toBe(1); // retryable: false → one attempt, not fifteen
  expect(halted.afterOffset).toBeGreaterThanOrEqual(marks[2].offset); // the cursor stood after the good marks…
  expect(halted.afterOffset).toBeLessThan(poisoned.offset); // …and before the poison
  expect(halted.error).toMatch(/poison/);
  const fact = (await itx.read(0, 500)).events.find((e: { type: string }) => e.type === HALTED);
  expect(fact?.payload).toMatchObject({
    name: "digest",
    attempts: 1,
    afterOffset: halted.afterOffset,
  });
  expect(await digested()).toBe("3"); // halted: nothing more was delivered

  // 4. recovery is ONE operator event, a plain append: resumed { afterOffset: poisoned.offset }
  //    un-halts and seeks the cursor past the poison — and the resumed fact IS the wake: the loop
  //    pumps that name on its commit, whatever the row's `consumes` says. The stuck mark lands on
  //    its own (3 → 4): the seek skipped exactly the poison, and at-least-once delivery resumed.
  await itx.append({ type: RESUMED, payload: { name: "digest", afterOffset: poisoned.offset } });
  await until(
    "digest=4 (resume alone, past the poison)",
    async () => (await digested()) === "4",
    30_000,
  );
  const rowAfter = await itx.subscriptions.get("digest");
  expect(rowAfter.halted).toBeUndefined();
  expect(rowAfter.cursor.attempt).toBe(0);
  expect(rowAfter.cursor.confirmedOffset).toBeGreaterThanOrEqual(stuck.offset);
  expect(stuck.offset).toBeGreaterThan(poisoned.offset); // the seek landed between the two
  // …and the lane keeps flowing afterwards.
  await itx.append({ type: "mark" });
  await until("digest=5", async () => (await digested()) === "5", 30_000);
});

// The still-true half of the deleted resume-race-control.e2e: a PLAIN failure (no resume in play)
// schedules the ladder — ~1s, on the DO's alarm — and the batch redelivers; the ladder resets on
// success.
test("cursor lane: a plain throw climbs the retry ladder on the DO's alarm — redelivered within seconds, attempt back to 0", async () => {
  const itx = openItx(freshCtx("ladder"));
  await mountLedger(itx, "throw");

  const [m1] = await itx.append({ type: "mark", payload: { n: 1 } });
  // delivery #1 throws (a plain Error — retryable) → attempt 1, the next try armed on the alarm
  const backingOff = await until("ladder step", async () => {
    const r = await itx.subscriptions.get("ledger");
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
    const r = await itx.subscriptions.get("ledger");
    return r?.cursor && r.cursor.attempt === 0 && r.cursor.confirmedOffset >= m1.offset
      ? r
      : undefined;
  });
  expect(settled.cursor.nextAttemptAtMs).toBeUndefined();
  expect(settled.halted).toBeUndefined();
});

// The still-true half of the deleted resume-race.e2e: a `subscription-delivery-resumed` appended
// WHILE a delivery is in flight WINS — the in-flight success must not advance the cursor past the
// seek; the batch redelivers from the seek, and the row keeps delivering afterwards.
test("cursor lane: a resumed event appended MID-DELIVERY wins — m1 redelivers from the seek, liveness holds", async () => {
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
  const row = await itx.subscriptions.get("ledger");
  expect(row.halted).toBeUndefined();
  expect(row.cursor.attempt).toBe(0);
  expect(row.cursor.confirmedOffset).toBeGreaterThanOrEqual(m2.offset);
});
