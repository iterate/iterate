// __tests__/failing-delivery.test.ts — BUG HUNT over the two subscription delivery lanes:
//   • CONNECTED lane: stream-durable-object.ts #deliverToConnectedSubscriptions (fire-and-forget
//     batches + the #subscriptionDeliveredThrough watermark, ranges must CHAIN);
//   • ABSENT/FORWARDER lane: subscription-forwarder-processor.ts (per-row cursor, the ONE
//     bounded-retry-then-halt policy, subscription-resumed cursor surgery).
//
// Every test asserts CORRECT behavior. `test.fails` marks behavior VERIFIED BROKEN by running
// against the real worker (wrangler createTestHarness) — each carries BUG/EXPECTED/ACTUAL/WHY.
// Run: pnpm exec vitest run --project harness failing-delivery

import { createRequire } from "node:module";
import { dirname } from "node:path";
import { newWebSocketRpcSession } from "capnweb";
import { afterAll, beforeAll, expect, test } from "vitest";
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

/** ACTIVE subscriber rows off the capability-table snapshot (newest mount per name wins — the
 *  shadow-stack projection the deleted hostState() used to serve). Presence facts read the SAME
 *  event-sourced door: a live row's existence IS "the stub is mounted"; transport socket counts
 *  are DO-only (`transportState()`, off this capnweb lane). */
async function subscriberRows(itx: any): Promise<any[]> {
  const snap: any = await itx.invokeCapability("itx.facets.get('capability-table').snapshot()");
  const byName = new Map<string, any>();
  for (const m of snap.state.mounts as any[]) {
    if (m.path.length !== 3 || m.path[0] !== "itx" || m.path[1] !== "subscribers") continue;
    const cur = byName.get(m.path[2]);
    if (!cur || m.providedAtOffset > cur.providedAtOffset)
      byName.set(m.path[2], { name: m.path[2], ...m });
  }
  return [...byName.values()];
}
/** Enabled facet processors = the facet-lane subscriber rows (a processor IS such a row). */
const facetProcessorSlugs = async (itx: any): Promise<string[]> =>
  (await subscriberRows(itx)).filter((r) => r.lane === "facet").map((r) => r.name);

/** A subscriber callback that records every invocation (deep-cloned — capnweb payloads must not
 *  be read after the callback's turn). Works verbatim on BOTH lanes: connected targets get it
 *  directly, absent targets reach it through a parked live-capability alias (mountHook). */
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

// Client-side sessions retained for the whole file so nothing disposes a parked callback while
// a test still needs it (a live mount's transport dies with its providing session).
const keep: unknown[] = [];

/** Mount a live callback at `itx.<name>` and return the PATH — the subscription then names the
 *  path string, an ABSENT target expression from the subscription lane's point of view (NOT the
 *  live callback itself), so it rides the subscription-forwarder facet, yet each delivery still
 *  calls back into this test process through the path's live mount. */
async function mountHook(itx: any, name: string, fn: (...args: any[]) => unknown): Promise<string> {
  await itx.provide(`itx.${name}`, fn);
  return `itx.${name}`;
}

// ─────────────────────────────── CONNECTED LANE ───────────────────────────────

test("connected lane: delivered ranges CHAIN across a consumes-filtered quiet gap", async () => {
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

test("connected lane: consumes naming an ephemeral type opts in; the consumes-less default excludes ephemerals", async () => {
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
  // the filter is exact: the opted-in row saw ONLY its named type; the default row NEVER saw
  // the ephemeral (ephemerals must be named to be delivered — same rule as processors)
  expect(optedIn.types()).toEqual(["chunk"]);
  expect(dflt.types()).not.toContain("chunk");
});

test("FIXED (defect 10): consumes ['*'] delivers every durable event on the connected lane", async () => {
  // BUG: #deliverToConnectedSubscriptions filters with `row.consumes.includes(e.type)` — the
  //   "*" wildcard is treated as a literal type name and matches nothing.
  // EXPECTED: the lane's own comment says the consumes filter is "the processor consumes rule,
  //   mirrored", and that rule (core/processor.ts #consumes) reads `consumes.includes("*") ||
  //   consumes.includes(e.type)` for durable events — so consumes:["*"] must deliver every
  //   durable event, exactly like omitting consumes.
  // ACTUAL: a subscriber with consumes:["*"] receives zero deliveries, forever, silently.
  // WHY IT MATTERS: "*" is the standard spelling everywhere else in this codebase (tally,
  //   user-tally, every apps/os processor) — porting that spelling into a subscription produces
  //   a silently-dead subscription with no error anywhere.
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

test("connected lane: unsubscribe stops deliveries at the revoke offset", async () => {
  const itx = await harness.itx("prj_fd_bye");
  const c = collector();
  await itx.subscribe({ name: "bye", consumes: ["mark"], target: c.fn });
  const [m1] = await append(itx, { type: "mark" });
  const [m2] = await append(itx, { type: "mark" });
  await until("both pre-revoke marks", () => c.offsets().length >= 2);
  await itx.unsubscribe({ name: "bye" });
  await append(itx, { type: "mark" });
  await append(itx, { type: "mark" });
  await settle(600);
  // nothing at or beyond the revoke offset may arrive — the mount died inside the revoke commit
  expect([...c.offsets()].sort((a, b) => a - b)).toEqual([m1.offset, m2.offset]);
});

test("connected lane: re-subscribing the same name REPLACES — the old callback's transport is dropped and it stops receiving", async () => {
  const itx = await harness.itx("prj_fd_shadow");
  const a = collector();
  const b = collector();
  await itx.subscribe({ name: "dup", consumes: ["mark"], target: a.fn });
  await itx.subscribe({ name: "dup", consumes: ["mark"], target: b.fn }); // replaces a's transport
  const [m] = await append(itx, { type: "mark" });
  await until("the replacing row delivered", () => b.offsets().includes(m.offset));
  await settle(400);
  expect(b.offsets()).toEqual([m.offset]);
  // the replaced callback is dead for delivery — its parked connection was dropped at
  // re-subscribe (close reason "replaced"; path = identity, one live row per path)
  expect(a.offsets()).toEqual([]);
});

test("connected lane: a throwing subscriber callback never hurts the producer and is never retried", async () => {
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
});

// ─────────────────────────────── FORWARDER LANE ───────────────────────────────

test("FIXED (defect 11): consumes ['*'] delivers every durable event on the forwarder lane", async () => {
  // BUG: the pump filters with `page.events.filter((e) => row.consumes!.includes(e.type))`
  //   (subscription-forwarder-processor.ts) — "*" is a literal there too; every page is
  //   "everything filtered", the cursor silently confirms through and nothing ever delivers.
  // EXPECTED: consumes:["*"] behaves like the processor consumes rule — every durable event.
  // ACTUAL: zero deliveries, cursor advances silently, no halt, no error — the worst failure
  //   shape (the mount row looks healthy while dropping everything).
  // WHY IT MATTERS: same spelling trap as the connected lane, but here it also LOOKS alive:
  //   the row pumps, confirms offsets, and never calls the target once.
  const itx = await harness.itx("prj_fd_star_fwd");
  const star = collector();
  const control = collector();
  const starHook = await mountHook(itx, "starHook", star.fn);
  const controlHook = await mountHook(itx, "controlHook", control.fn);
  await itx.subscribe({ name: "star", consumes: ["*"], target: starHook });
  await itx.subscribe({ name: "control", consumes: ["note"], target: controlHook });
  const [note] = await append(itx, { type: "note" });
  await until("control got it (the lane works)", () => control.offsets().includes(note.offset));
  await settle(400);
  expect(star.offsets()).toContain(note.offset);
});

test("forwarder lane: ephemeral events NEVER deliver to absent targets, even when consumes names the type", async () => {
  // CONTRACT PIN (decided — document, don't reject): the forwarder pump reads DURABLE rows only,
  // so an absent-target subscription never sees an ephemeral instance of a type its consumes
  // names — while a durable instance of the SAME type delivers normally. Subscribe cannot warn
  // at mount time: ephemerality is per-EVENT, not per-type, so consumes:["blip"] is a perfectly
  // valid spelling that simply filters whatever durable "blip"s exist. (Contrast the connected
  // lane above, where naming the type is exactly how a subscriber opts IN to ephemerals.)
  const itx = await harness.itx("prj_fd_eph_fwd");
  const c = collector();
  const hook = await mountHook(itx, "ephFwdHook", c.fn);
  await itx.subscribe({ name: "eph-fwd", consumes: ["blip"], target: hook });
  const [eph] = await append(itx, { type: "blip", ephemeral: true, payload: { kind: "eph" } });
  await settle(800); // bounded negative wait — the pump gets ample time to (not) deliver
  expect(c.invocations).toEqual([]);
  const [durable] = await append(itx, { type: "blip", payload: { kind: "durable" } });
  // the durable delivery is also the barrier: the pump has now confirmed PAST the ephemeral
  await until("the durable blip delivers", () => c.offsets().includes(durable.offset));
  await settle(300);
  expect(c.offsets()).toEqual([durable.offset]); // exactly the durable instance, nothing else
  expect(c.offsets()).not.toContain(eph.offset);
});

test("forwarder: maxAttempts 1 halts after exactly ONE attempt, leaves the audit fact, and stays halted", async () => {
  const itx = await harness.itx("prj_fd_halt1");
  let attempts = 0;
  const hook = await mountHook(itx, "haltHook", () => {
    attempts++;
    throw new Error("target down");
  });
  await itx.subscribe({ name: "halty", target: hook, consumes: ["mark"], maxAttempts: 1 });
  await append(itx, { type: "mark" });
  const halt = await until("halt audit fact on the stream", async () =>
    (await readAll(itx)).find(
      (e) =>
        e.type === "events.iterate.com/stream/subscription-delivery-halted" &&
        e.payload?.name === "halty",
    ),
  );
  expect(halt.payload.reason).toMatch(/1 delivery attempts failed/);
  expect(attempts).toBe(1); // the ladder burned exactly one attempt before halting
  await append(itx, { type: "mark" }); // fresh traffic must not resurrect a halted row
  await settle(800);
  expect(attempts).toBe(1);
});

test("forwarder: resume errors are loud and matchable (unknown name; connected rows have no cursor)", async () => {
  const itx = await harness.itx("prj_fd_resumeerr");
  await expect(itx.resumeSubscription({ name: "never-was" })).rejects.toThrow(
    /no subscription "never-was"/,
  );
  const c = collector();
  await itx.subscribe({ name: "conny", consumes: ["mark"], target: c.fn });
  await expect(itx.resumeSubscription({ name: "conny" })).rejects.toThrow(/no server cursor/);
});

test("forwarder: resume while HEALTHY redelivers exactly the events after afterOffset (cursor surgery)", async () => {
  const itx = await harness.itx("prj_fd_replay");
  const c = collector();
  const hook = await mountHook(itx, "replayHook", c.fn);
  await itx.subscribe({ name: "replay", consumes: ["mark"], target: hook });
  const [m1] = await append(itx, { type: "mark", payload: { n: 1 } });
  const [m2] = await append(itx, { type: "mark", payload: { n: 2 } });
  const [m3] = await append(itx, { type: "mark", payload: { n: 3 } });
  await until("first wave", () => c.offsets().length >= 3);
  expect([...c.offsets()].sort((a, b) => a - b)).toEqual([m1.offset, m2.offset, m3.offset]);
  const before = c.invocations.length;
  await itx.resumeSubscription({ name: "replay", afterOffset: m1.offset });
  await until("redelivery", () => c.offsets().length >= 5);
  await settle(400);
  const redelivered = c.invocations.slice(before).flatMap((i) => i.events.map((e) => e.offset));
  // exactly-from-afterOffset: m2 and m3 once more, m1 (== afterOffset) NEVER redelivered
  expect(redelivered).toEqual([m2.offset, m3.offset]);
  // and the redelivered range starts surgically at the requested cursor
  expect(c.invocations[before].range.after).toBe(m1.offset);
});

test("FIXED (defect 13): resume with afterOffset beyond head is clamped — later events deliver", async () => {
  // BUG: pump.reset stores afterOffset verbatim; #pumpRow then reads read(cursor) whose
  //   scannedThroughOffset is max(afterOffset, head) — with cursor > head that is always ==
  //   cursor, so `page.scannedThroughOffset <= progress.confirmedOffset` reports caught-up
  //   FOREVER while real events commit at offsets below the cursor.
  // EXPECTED: an over-shot afterOffset clamps to the head (or errors loudly at
  //   resumeSubscription) — either way the NEXT appended event must deliver.
  // ACTUAL: every event appended after the resume lands at an offset below the parked cursor
  //   and is silently skipped until the stream organically burns past the overshoot (here:
  //   1000 offsets away — effectively never).
  // WHY IT MATTERS: resumeSubscription is THE operator recovery verb; a fat-fingered
  //   afterOffset during an incident converts a halted-but-recoverable row into a silently
  //   dead one with no error and no audit fact.
  const itx = await harness.itx("prj_fd_beyond");
  const c = collector();
  const hook = await mountHook(itx, "beyondHook", c.fn);
  await itx.subscribe({ name: "beyond", consumes: ["mark"], target: hook });
  const [m1] = await append(itx, { type: "mark", payload: { n: 1 } });
  await until("lane works", () => c.offsets().includes(m1.offset));
  await itx.resumeSubscription({ name: "beyond", afterOffset: m1.offset + 1000 });
  const [m2] = await append(itx, { type: "mark", payload: { n: 2 } });
  await until("the event after the resume delivers", () => c.offsets().includes(m2.offset), 5_000);
});

test("FIXED (defect 12): unsubscribe during an in-flight delivery leaves no ghost halt", async () => {
  // BUG: pump.forget (revoke) deletes the row's SubscriptionDeliveryProgress, but the CAS in
  //   #pumpRow compares `(fresh?.rev ?? 0) !== (progress.rev ?? 0)` — a DELETED record (fresh
  //   = undefined) and a never-reset one (rev undefined) both coerce to 0, so the in-flight
  //   delivery's success path happily re-puts the record (resurrecting storage for a revoked
  //   row), loops, reads the next durable event (the revoke fact itself), and tries to deliver
  //   it — which throws "no subscription mount at offset N" — and the failure ladder then
  //   HALTS and appends a subscription-delivery-halted audit fact for a row that was cleanly
  //   unsubscribed.
  // EXPECTED: after unsubscribe, the row attempts nothing further — no delivery attempts, no
  //   halt audit fact, no resurrected progress record.
  // ACTUAL: a spurious events.iterate.com/stream/subscription-delivery-halted for the revoked
  //   name lands on the stream (and an orphaned progress record is re-minted in facet storage).
  // WHY IT MATTERS: halt audit facts are the operator's signal that a live subscription needs
  //   attention; a revoked row emitting one is a false alarm — and the resurrected progress
  //   row is a permanent storage leak keyed by a mount that no longer exists.
  const itx = await harness.itx("prj_fd_ghost");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let invocations = 0;
  const hook = await mountHook(itx, "ghostHook", async () => {
    invocations++;
    await gate; // hold THIS delivery in flight while the row is revoked underneath it
  });
  await itx.subscribe({ name: "ghost", target: hook, maxAttempts: 1 });
  const [mark] = await append(itx, { type: "mark" });
  await until("delivery in flight", () => invocations >= 1);
  await itx.unsubscribe({ name: "ghost" });
  // barrier: the forwarder's reduce has passed the revoke commit (its cursor moved beyond it)
  await until(
    "forwarder reduced the revoke",
    async () =>
      (await itx.invokeCapability("itx.facets.get('subscription-forwarder').snapshot()")).offset >
      mark.offset,
  );
  release();
  // correct behavior: the revoked row goes quiet — poll generously for the spurious audit fact
  let haltEvent: any;
  const t0 = Date.now();
  while (Date.now() - t0 < 5_000 && !haltEvent) {
    haltEvent = (await readAll(itx)).find(
      (e) =>
        e.type === "events.iterate.com/stream/subscription-delivery-halted" &&
        e.payload?.name === "ghost",
    );
    if (!haltEvent) await settle(150);
  }
  expect(invocations).toBe(1); // the callback itself was never re-offered (sanity)
  expect(haltEvent).toBeUndefined(); // and no halt audit fact may exist for a revoked row
});

test("forwarder: row isolation — one halted row never blocks its neighbor", async () => {
  const itx = await harness.itx("prj_fd_iso");
  let badAttempts = 0;
  const good = collector();
  const badHook = await mountHook(itx, "isoBad", () => {
    badAttempts++;
    throw new Error("permanently down");
  });
  const goodHook = await mountHook(itx, "isoGood", good.fn);
  await itx.subscribe({ name: "bad", target: badHook, consumes: ["mark"], maxAttempts: 1 });
  await itx.subscribe({ name: "good", target: goodHook, consumes: ["mark"] });
  const [m1] = await append(itx, { type: "mark", payload: { n: 1 } });
  await until("bad halted", async () =>
    (await readAll(itx)).some(
      (e) =>
        e.type === "events.iterate.com/stream/subscription-delivery-halted" &&
        e.payload?.name === "bad",
    ),
  );
  await until("good got m1", () => good.offsets().includes(m1.offset));
  const [m2] = await append(itx, { type: "mark", payload: { n: 2 } });
  await until("good keeps delivering AFTER the neighbor halted", () =>
    good.offsets().includes(m2.offset),
  );
  expect(badAttempts).toBe(1);
  expect([...good.offsets()].sort((a, b) => a - b)).toEqual([m1.offset, m2.offset]); // no dups
});

test("forwarder auto-enables exactly once across many absent-target subscribes", async () => {
  const ctx = "prj_fd_auto";
  const itx = await harness.itx(ctx);
  await Promise.all(
    [1, 2, 3].map((i) =>
      itx.subscribe({ name: `auto-${i}`, target: `itx.sink${i}`, consumes: ["never"] }),
    ),
  );
  expect(
    (await facetProcessorSlugs(itx)).filter((s: string) => s === "subscription-forwarder"),
  ).toHaveLength(1);
  const rows = (await subscriberRows(itx)).filter((r: any) => r.name.startsWith("auto-"));
  expect(rows).toHaveLength(3);
  for (const r of rows) expect(r.lane).toBe("durable");
});

test("liveState subscribe with an ABSENT target is rejected loudly at provide", async () => {
  const itx = await harness.itx("prj_fd_lsbad");
  await expect(
    itx.subscribe({ name: "lsbad", liveState: { key: "chat" }, target: "itx.wherever" }),
  ).rejects.toThrow(/needs a LIVE callback target/);
  // and the rejected mount left nothing behind
  expect(await subscriberRows(itx)).toEqual([]);
});

// ─────────────────────────────── CROSS-LANE + PATHOLOGICAL ───────────────────────────────

test("cross-lane agreement: a connected and a forwarder subscriber see the SAME offsets in order", async () => {
  const itx = await harness.itx("prj_fd_lanes");
  const conn = collector();
  const fwd = collector();
  await itx.subscribe({ name: "lane-conn", consumes: ["mark"], target: conn.fn });
  const hook = await mountHook(itx, "laneHook", fwd.fn);
  await itx.subscribe({ name: "lane-fwd", consumes: ["mark"], target: hook });
  const committed: any[] = [];
  for (let i = 0; i < 5; i++)
    committed.push(...(await append(itx, { type: "mark", payload: { i } })));
  const offsets = committed.map((e) => e.offset);
  await until("both lanes done", () => conn.offsets().length >= 5 && fwd.offsets().length >= 5);
  expect([...conn.offsets()].sort((a, b) => a - b)).toEqual(offsets);
  expect([...fwd.offsets()].sort((a, b) => a - b)).toEqual(offsets);
  // within every single delivery, offsets ascend (batch order is log order on both lanes)
  for (const lane of [conn, fwd])
    for (const inv of lane.invocations) {
      const off = inv.events.map((e) => e.offset);
      expect(off).toEqual([...off].sort((a, b) => a - b));
    }
});

test("PATHOLOGICAL: 200 connected subscription mounts — one append fans out to all 200 in under 2s", async () => {
  const itx = await harness.itx("prj_fd_fanout");
  const counts = new Array(200).fill(0);
  let received = 0;
  // consumes:["ping"] keeps the 200 setup provides from fanning out N² deliveries
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
  // the measured round: steady-state fan-out of ONE append across 200 mounts
  const t0 = Date.now();
  await append(itx, { type: "ping", payload: { round: 2 } });
  await until("all 200 received round 2", () => received >= 400, 10_000, 10);
  const wallMs = Date.now() - t0;
  console.log(`fan-out: cold(first-page) ${coldWallMs}ms, warm ${wallMs}ms for 200 mounts`);
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

test("MEASURED FINDING: a connected subscriber that stops reading mid-flood is NOT closed by local workerd (≥60MiB buffers silently) — but a real socket close reaps the mount instantly", async () => {
  // The lane's design comment (stream-durable-object.ts, connected lane): "the socket buffer is
  // the only queue; overflow closes the socket and the close IS the heal signal". This test ran
  // that claim to ground against local workerd. It is NOT a test.fails: the buffering policy is
  // workerd's, not this codebase's — what IS ours (close → onRpcBroken → pager close →
  // onFinalClose → auto-revoke) is proven live below.
  // EXPECTED (design): a client that stops reading its /api socket eventually overflows the
  //   server's send buffer; workerd closes the socket; the relay's onRpcBroken closes the stub
  //   pager; the DO auto-revokes the mount (the capability table's row drops).
  // ACTUAL (measured, local workerd via wrangler createTestHarness): 60.0MiB of payload flooded
  //   into a TCP-paused subscriber produced NO close, NO delivery.event-batch.dropped warn, NO
  //   CONNECTION_OFFLINE — the mount stayed listed and the stub stayed attached (stubs=1).
  //   workerd buffers the outgoing WebSocket without any local limit we could reach. The chain
  //   itself is sound: hard-killing the stalled socket reaped the mount in 10–30ms (stubs=0).
  // RESIDUAL: live Cloudflare is NOT proven either way here — real edge sockets have real buffer
  //   limits, so the overflow-close half may well hold in production; this pin documents LOCAL
  //   workerd only. If the still-mounted assertion below ever fails, workerd grew a send-buffer
  //   limit — upgrade this pin to assert the overflow-close instead.
  const ctx = "prj_fd_overflow";
  const itx = await harness.itx(ctx); // connection A: setup, the flood, and observation
  // Connection B — THE VICTIM: its own client socket, because the retained callback stub lives in
  // that socket's relay session; the socket's death must become the stub's death.
  const wsB = stallableWebSocket(`ws://${harness.url.host}/api?ctx=${ctx}`);
  const sessionB: any = newWebSocketRpcSession(wsB as any);
  keep.push(sessionB);
  const victim = sessionB.authenticate().get();
  const c = collector();
  await victim.subscribe({ name: "victim", consumes: ["flood"], target: c.fn });
  // one probe proves the lane end-to-end BEFORE the stall
  await append(itx, { type: "flood", ephemeral: true, payload: { probe: true } });
  await until("probe delivered over the victim socket", () => c.invocations.length >= 1);
  const before = await subscriberRows(itx);
  // the victim's row is LIVE (its parked stub's presence — the event-sourced fact; the raw
  // transport count is a DO-only transportState() fact, unreachable from this capnweb lane)
  expect(before).toContainEqual(
    expect.objectContaining({ name: "victim", lane: "connected", live: true }),
  );
  const droppedWarns = () =>
    (JSON.stringify(harness.logs()).match(/delivery\.event-batch\.dropped/g) ?? []).length;
  const droppedBefore = droppedWarns(); // logs are harness-global — assert the DELTA, not zero

  // THE STALL: stop reading the victim's TCP socket. The kernel recv buffer fills, the TCP window
  // closes, and workerd's sends for this socket can only buffer.
  wsB._socket.pause();

  // THE FLOOD: ephemeral events (memory-only server-side) with chunky payloads, ~0.5MiB per append
  // (two 256KiB events — each hop's message stays under production's 1MiB WebSocket-message cap).
  // Bounded at 60MiB; bail the moment the mount is reaped (it never was — see ACTUAL).
  const chunk = "x".repeat(256 * 1024);
  const victimReaped = async () =>
    !(await subscriberRows(itx)).some((m: any) => m.name === "victim");
  let floodedBytes = 0;
  let reaped = false;
  for (let i = 0; i < 120 && !reaped; i++) {
    await append(
      itx,
      { type: "flood", ephemeral: true, payload: { i, chunk } },
      { type: "flood", ephemeral: true, payload: { i: i + 0.5, chunk } },
    );
    floodedBytes += 2 * chunk.length;
    reaped = await victimReaped();
  }
  // bounded negative wait: when a close DOES propagate, the reap lands in tens of ms (measured
  // below via the kill) — 1.5s is ample for an overflow-close triggered by the flood to surface.
  if (!reaped) {
    const tGrace = Date.now();
    while (Date.now() - tGrace < 1_500 && !reaped) {
      reaped = await victimReaped();
      if (!reaped) await settle(150);
    }
  }
  const after = await subscriberRows(itx);
  console.log(
    `overflow: flooded ${(floodedBytes / 1024 / 1024).toFixed(1)}MiB into a paused socket; ` +
      `reaped=${reaped}; dropped-warn delta=${droppedWarns() - droppedBefore}`,
  );
  // THE FINDING, pinned: the full 60MiB went in and NOTHING happened — no close, no reap, no
  // dropped-delivery warn. workerd absorbed it all in memory.
  expect(floodedBytes).toBe(120 * 2 * 256 * 1024);
  expect(reaped).toBe(false);
  expect(after).toContainEqual(expect.objectContaining({ name: "victim", live: true }));
  expect(droppedWarns() - droppedBefore).toBe(0);

  // THE CHAIN IS SOUND: hard-kill the stalled socket (RST — no close handshake a paused reader
  // could never read) and the reap fires end-to-end: relay onRpcBroken → pager close → DO
  // onFinalClose → auto-revoke. Measured 10–30ms; the until bound is generous, not a latency pin.
  const tKill = Date.now();
  wsB.terminate();
  await until("mount reaped after the socket died", victimReaped, 15_000);
  // the victim was this ctx's only mount; its auto-revoke proves the transport died end-to-end
  expect(await subscriberRows(itx)).toEqual([]);
  console.log(`socket kill → mount reaped in ${Date.now() - tKill}ms`);
}, 55_000);
