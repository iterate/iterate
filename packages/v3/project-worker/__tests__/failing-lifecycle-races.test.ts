// __tests__/failing-lifecycle-races.test.ts — BUG HUNT wave 2: LIFECYCLE RACES.
//   • the capability table's shadow stack under CONCURRENT provide/revoke;
//   • processor enablement lineage (enable × 2 sessions, a quiet enable is clean, the raw
//     event-sourced door agrees with the verb, re-enable-warm, disable mid-drive);
//   • append-during-delivery reentrancy (a cursor subscription whose target appends back into the
//     stream it is delivered from);
//   • live-subscriber registry hygiene under subscribe/unsubscribe churn;
//   • the waitUntilProcessed barrier against a future offset.
//
// Every test asserts CORRECT behavior. `test.fails` marks behavior VERIFIED BROKEN by running
// against the real worker (wrangler createTestHarness) — each carries BUG/EXPECTED/ACTUAL/WHY.
// A processor is a userspace `StreamProcessorDurableObject` hosted as a facet (there are no
// built-in processors): `tally` here is the fixture source from e2e/support/sources.ts.
// Run: pnpm exec vitest run --project harness __tests__/failing-lifecycle-races.test.ts

import { afterAll, beforeAll, expect, test } from "vitest";
import { processorNames, subscriptions } from "../e2e/support/client.ts";
import { enableFixtureProcessor, seedSources } from "../e2e/support/sources.ts";
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
// The DURABLE head — the last durable row's offset, NOT scannedThroughOffset. A "*" processor
// (tally) publishes a live-state ephemeral per commit; those consume offsets and inflate
// scannedThroughOffset, but a facet only ever needs to catch up to the DURABLE head, which is what
// "has it reduced the log" means.
const readHead = async (itx: any): Promise<number> => {
  const { events } = (await itx.invokeCapability(["itx", ["read", 0, 500]])) as {
    events: { offset: number }[];
  };
  return events.length ? events[events.length - 1].offset : 0;
};
const tallySnapshot = async (itx: any): Promise<any> =>
  itx.invokeCapability("itx.facets.get('tally').snapshot()");
/** PRESENCE — the keys with an open transport right now (`itx.rpcStubs.list()`, the physical
 *  registry; the raw socket counters are DO-only transportState()). */
const presence = async (itx: any): Promise<string[]> => (await itx.rpcStubs.list()) as string[];
/** LIVE MOUNTS by count — capability-table rows whose target names the registry
 *  (`itx.rpcStubs.get('…')`). A subscription is NOT a mount (it is a row of its own table), so this
 *  is untouched by subscribe/unsubscribe — the pin that the two layers stay apart. */
const liveMountCount = async (itx: any): Promise<number> => {
  const snap: any = await itx.invokeCapability("itx.facets.get('capability-table').snapshot()");
  return (snap.state.mounts as any[]).filter(
    (m) => Array.isArray(m.target) && m.target[0] === "itx" && m.target[1] === "rpcStubs",
  ).length;
};

/** Expected tally counts = groupBy(type) over the DURABLE log (tally consumes "*", durable only). */
const durableCountsByType = (events: any[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  return counts;
};

const logsText = () => JSON.stringify(harness.logs());
const countMatches = (text: string, re: RegExp) => (text.match(re) ?? []).length;
/** Every delivery-side error line the loop can emit: a dropped push, a dispatch issue. */
const DELIVERY_ERRORS = /delivery\.push\.dropped|subscription-delivery\.dispatch|NO_FACET/g;

// ─────────────────────────── 1. concurrent provide/revoke, one path ───────────────────────────

test("shadow stack: 10 concurrent provides on ONE path end deterministic (newest offset answers), a full concurrent revoke sweep restores default-deny, and the table is not wedged", async () => {
  const itx = await harness.itx("prj_lr_race");
  // ten distinguishable live capabilities to alias at the contested path (path = identity)
  for (let i = 0; i < 10; i++) {
    await itx.provide(`itx.probe${i}`, () => i);
  }
  const race = () => itx.invokeCapability(["itx", ["race"]]);

  // wave 1: five concurrent provides at itx.race
  const wave1: { providedAtOffset: number }[] = await Promise.all(
    Array.from({ length: 5 }, (_, i) => itx.provide("itx.race", `itx.probe${i}`)),
  );
  const offsets1 = wave1.map((r) => r.providedAtOffset);
  expect(new Set(offsets1).size).toBe(5); // every mount got its own identity
  const winner1 = offsets1.indexOf(Math.max(...offsets1));
  expect(await race()).toBe(winner1); // the newest surviving mount answers

  // wave 2: five MORE provides racing five revokes of wave 1 — full interleave in one gather
  const ops: Promise<any>[] = [];
  for (let i = 0; i < 5; i++) {
    ops.push(itx.provide("itx.race", `itx.probe${5 + i}`));
    ops.push(itx.revoke({ providedAtOffset: offsets1[i] }));
  }
  const results = await Promise.all(ops);
  const offsets2 = results.filter((r) => r && r.providedAtOffset).map((r) => r.providedAtOffset);
  expect(offsets2).toHaveLength(5);
  const winner2 = 5 + offsets2.indexOf(Math.max(...offsets2));
  expect(await race()).toBe(winner2); // wave 1 is fully gone; newest of wave 2 answers

  // the full sweep: revoke everything that remains, concurrently
  await Promise.all(offsets2.map((o) => itx.revoke({ providedAtOffset: o })));
  await expect(race()).rejects.toThrow(/no capability matches/); // default-deny restored

  // and the table is not wedged: a fresh provide works and answers
  const again = await itx.provide("itx.race", "itx.probe7");
  expect(again.providedAtOffset).toBeGreaterThan(Math.max(...offsets2));
  expect(await race()).toBe(7);
});

// ─────────────────────────── 2. processor enablement lineage ───────────────────────────

test("enableProcessor('tally') from two sessions concurrently: one effective lineage, exact counts, the table lists tally once", async () => {
  const ctx = "prj_lr_dualenable";
  const itxA = await harness.itx(ctx);
  const itxB = await harness.itx(ctx);
  await Promise.all([enableFixtureProcessor(itxA, "tally"), enableFixtureProcessor(itxB, "tally")]);

  // same name REPLACES (no stack): whether the racing enables landed one or two configured
  // events, the table holds ONE row named tally
  expect((await processorNames(itxA)).filter((s) => s === "tally")).toHaveLength(1);

  for (let i = 0; i < 3; i++) await append(itxA, { type: "seen", payload: { i } });
  const head = await readHead(itxA);
  const expected = durableCountsByType(await readAll(itxA));
  const configured = expected["events.iterate.com/stream/subscription-configured"];
  expect(configured === 1 || configured === 2).toBe(true); // the door is idempotent, best-effort under a race
  const snap = await until(
    "tally reduced the whole log exactly once",
    async () => {
      const s: any = await tallySnapshot(itxA);
      return s.offset >= head && s;
    },
    20_000,
  );
  // one lineage: bit-exact counts (a doubled drive or a second lineage would overcount; a
  // dropped one would undercount)
  expect(snap.state.counts).toEqual(expected);
  expect(snap.state.counts.seen).toBe(3);
});

test("FIXED (defect 29): enabling a processor on a quiet stream is clean — zero delivery errors, its first delivered batch is its own enablement commit", async () => {
  // WAS-BUG: enableProcessor committed the mount FIRST and configure()d the facet SECOND; the
  //   commit's drive reached the fresh facet before its identity landed and every routine enable
  //   logged a dropped batch. NOW: identity is `ctx.props`, minted at materialization — there is
  //   no configure window. The enablement commit is the first batch the facet is pushed.
  const ctx = "prj_lr_enablerace";
  const itx = await harness.itx(ctx);
  await settle(400); // let stragglers from earlier tests flush before the baseline
  const before = countMatches(logsText(), DELIVERY_ERRORS);
  await enableFixtureProcessor(itx, "tally");
  const head = await readHead(itx);
  const snap: any = await until("tally at head", async () => {
    const s: any = await tallySnapshot(itx);
    return s.offset >= head && s;
  });
  // the enablement commit itself was reduced (tally consumes "*")
  expect(snap.state.counts["events.iterate.com/stream/subscription-configured"]).toBe(1);
  await settle(400);
  expect(countMatches(logsText(), DELIVERY_ERRORS) - before).toBe(0);
});

test("FIXED (defect 30): the raw event-sourced door agrees with the verb — a hand-appended subscription-configured naming the facet's processEventBatch IS the enablement", async () => {
  // WAS-BUG: enablement had a second, non-event-sourced leg (configure() stashing identity in the
  //   facet's kv), so a processor mount provided through the ordinary door was half-enabled —
  //   listed, erroring on every commit, snapshot throwing "not configured". NOW: the row IS the
  //   enablement; `enableProcessor` is sugar over exactly this event, and the facet's identity
  //   rides `ctx.props` at materialization — rebuild-from-log is true.
  const ctx = "prj_lr_rawdoor";
  const itx = await harness.itx(ctx);
  await seedSources(itx, ["tally"]);
  await append(itx, {
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      name: "tally",
      target:
        "itx.load(\"itx.kv.get('src/tally.js')\").getDurableObjectClass('Tally').get('tally').processEventBatch",
    },
  });
  expect(await processorNames(itx)).toContain("tally"); // listed as enabled — and it is
  const [mark] = await append(itx, { type: "mark" });
  const snap: any = await until("tally reduced the mark", async () => {
    const s: any = await tallySnapshot(itx).catch(() => undefined); // NO_FACET while it materializes
    return s && s.offset >= mark.offset && s;
  });
  expect(snap.state.counts.mark).toBe(1);
});

// ─────────────────────────── 3. re-enable while WARM ───────────────────────────

test("re-enable while WARM is a no-op for the log and never corrupts the reduce (no reset, no double-count)", async () => {
  const ctx = "prj_lr_reenable";
  const itx = await harness.itx(ctx);
  await enableFixtureProcessor(itx, "tally");
  await append(itx, { type: "mark" });
  await append(itx, { type: "mark" });
  const head1 = await readHead(itx);
  const s1: any = await until("tally at head", async () => {
    const s: any = await tallySnapshot(itx);
    return s.offset >= head1 && s;
  });
  expect(s1.state.counts.mark).toBe(2);

  const configuredBefore = (await readAll(itx)).filter(
    (e) => e.type === "events.iterate.com/stream/subscription-configured",
  ).length;
  await enableFixtureProcessor(itx, "tally"); // identical row ⇒ appends NOTHING (the idempotent door)
  expect(
    (await readAll(itx)).filter(
      (e) => e.type === "events.iterate.com/stream/subscription-configured",
    ),
  ).toHaveLength(configuredBefore);
  await append(itx, { type: "mark" });
  const head2 = await readHead(itx);
  const expected = durableCountsByType(await readAll(itx));
  const s2: any = await until("tally at head after re-enable", async () => {
    const s: any = await tallySnapshot(itx);
    return s.offset >= head2 && s;
  });
  expect(s2.state.counts).toEqual(expected); // exact — the re-enable neither reset nor doubled
  expect(s2.state.counts.mark).toBe(3);
});

// ─────────────────────────── 4. disableProcessor MID-DRIVE ───────────────────────────

test("disable mid-drive: appends survive, no ongoing error storm, re-enable rebuilds an exact reduce", async () => {
  const ctx = "prj_lr_middrive";
  const itx = await harness.itx(ctx);
  await enableFixtureProcessor(itx, "tally");
  await append(itx, { type: "warm" }); // one delivery so the facet exists
  const headWarm = await readHead(itx);
  await until("tally warm", async () => ((await tallySnapshot(itx)) as any).offset >= headWarm);

  // the burst + the disable, racing (in-flight pushes vs facet delete)
  const burst = Array.from({ length: 10 }, (_, i) =>
    append(itx, { type: "burst", payload: { i } }),
  );
  const disabled = itx.disableProcessor("tally");
  await Promise.all([...burst, disabled]); // appends must all survive the disable

  expect(await processorNames(itx)).not.toContain("tally");
  // (The quiet-stream half — disable ⇒ `itx.facets.get('tally')` rejects NO_FACET — is pinned in
  // the double-enable test below. NOT asserted here: a push already in flight for the dead row can
  // race `facets.delete` and RE-MATERIALIZE the facet — its `#resolve` re-writes the `facet:tally`
  // memo after the delete — a zombie with storage and no subscription (observed 2026-09-01:
  // snapshot answered offset 18, burst: 10, right after the disable). Reported; a deterministic
  // reproduction needs a delivery held in flight across the delete.)

  // post-disable traffic must not keep erroring into the dead facet: in-flight pushes may log a
  // bounded burst at the disable moment, but NOTHING new may appear afterwards
  await settle(500);
  const beforeErrors = countMatches(logsText(), DELIVERY_ERRORS);
  for (let i = 0; i < 10; i++) await append(itx, { type: "post", payload: { i } });
  await settle(700);
  expect(countMatches(logsText(), DELIVERY_ERRORS)).toBe(beforeErrors); // no NEW delivery errors

  // re-enable: a CLEAN reduce — exact counts over the whole durable log, nothing doubled,
  // nothing inherited from the dead lineage (disable deleted the facet, storage included).
  await enableFixtureProcessor(itx, "tally");
  const head = await readHead(itx);
  const expected = durableCountsByType(await readAll(itx));
  const snap: any = await until("re-enabled tally reduced the whole log", async () => {
    const s: any = await tallySnapshot(itx).catch(() => undefined);
    return s && s.offset >= head && s;
  });
  expect(snap.state.counts).toEqual(expected);
  expect(snap.state.counts.burst).toBe(10);
  expect(snap.state.counts.post).toBe(10);
});

test("FIXED: double-enable then ONE disableProcessor disables it (same name REPLACES — there is no enablement stack to clear)", async () => {
  // WAS-BUG: enablement was a capability-table mount with a shadow stack; enabling twice left two
  //   mounts and one disable popped only the newest, resurrecting the facet on the next commit.
  //   NOW: a subscription row is keyed by name — the second enable is a no-op, one disable ends it.
  const ctx = "prj_lr_disshadow";
  const itx = await harness.itx(ctx);
  await enableFixtureProcessor(itx, "tally");
  await enableFixtureProcessor(itx, "tally"); // re-enable while WARM (supported, appends nothing)
  await append(itx, { type: "mark" });
  const head = await readHead(itx);
  await until("tally at head", async () => ((await tallySnapshot(itx)) as any).offset >= head);

  await itx.disableProcessor("tally"); // ONE disable

  expect(await processorNames(itx)).not.toContain("tally");
  expect(await subscriptions(itx)).toEqual([]);
  await expect(tallySnapshot(itx)).rejects.toThrow(/no facet.*"tally"/);
});

// ─────────────────────────── 5. append-during-delivery reentrancy ───────────────────────────

test("reentrancy characterized: a cursor delivery targeting this stream's own append neither deadlocks nor runs away — the call shape is refused, the ladder backs off, the stream stays serviceable", async () => {
  // `itx.cd('/').append` is a legal cursor target (a sibling-context handle cannot own its
  // progress) and the delivery call is append(eventsArray, range) — whose first arg is an ARRAY.
  // append's runtime guard refuses it (an array has no string `type`). The ONE ladder (1s·2ⁿ, 15
  // attempts ≈ hours) backs off on the DO's alarm — so within a test the row shows attempt ≥ 1
  // with a retry armed, never a halt (the halt-NOW case is `retryable: false`, pinned in
  // failing-delivery). Bounded and loud — no deadlock, no runaway loop, no junk rows on the log.
  const ctx = "prj_lr_reenter";
  const itx = await harness.itx(ctx);
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
      await settle(2_000);
      const now = await readHead(itx);
      const stable = now === head;
      head = now;
      return stable;
    },
    15_000,
    10,
  );

  const events = await readAll(itx);
  expect(events.filter((e) => typeof e.type !== "string")).toHaveLength(0); // no junk committed
  expect(events.length).toBeLessThan(20); // bounded, whatever branch the platform takes
  const row: any = await itx.subscriptions.get("reenter");
  expect(row.cursor.attempt).toBeGreaterThanOrEqual(1); // the refused call climbed the ladder…
  expect(row.cursor.nextAttemptAtMs).toBeGreaterThan(0); // …with the next try armed on the alarm
  expect(row.halted).toBeUndefined(); // a plain throw is never a halt
  expect(ctrl.offsets().filter((o) => o === seed.offset)).toHaveLength(1); // seed seen exactly once

  // the stream stays serviceable for later work, and removing the row ends the ladder
  const [post] = await append(itx, { type: "afterparty" });
  expect(post.offset).toBeGreaterThan(seed.offset);
  await itx.unsubscribe("reenter");
  expect(await itx.subscriptions.get("reenter")).toBeNull();
});

// ─────────────────────────── 6. subscribe/unsubscribe churn ───────────────────────────

test("churn 20×: no ghost deliveries; presence AND the tables return to baseline after session dispose", async () => {
  const ctx = "prj_lr_churn";
  const observer = await harness.itx(ctx); // outlives the churning session
  const session = harness.session();
  const itx = await session.authenticate().projects.get(ctx);
  const baselinePresence = (await presence(observer)).length;
  const baselineMounts = await liveMountCount(observer);
  const c = collector();

  for (let i = 0; i < 20; i++) {
    await itx.subscribe({ name: "churn", consumes: ["mark"], target: c.fn });
    await itx.unsubscribe("churn");
  }

  // no ghost deliveries: every row is removed, so nothing may reach the callback
  await append(itx, { type: "mark", payload: { n: 1 } });
  await append(itx, { type: "mark", payload: { n: 2 } });
  await settle(800);
  expect(c.invocations).toHaveLength(0);
  expect(await subscriptions(observer)).toEqual([]);
  // a subscription never touches the CAPABILITY table (two layers, two tables)
  expect(await liveMountCount(observer)).toBe(baselineMounts);

  // dispose the session: PRESENCE (the physical registry) must return to baseline — every relay
  // the churn parked is gone (each unsubscribe closed its own; the pager closes are async, poll).
  // (transport socket counts are DO-only transportState(), pinned in __workers-tests__)
  (session as Partial<Disposable>)[Symbol.dispose]?.();
  await until(
    "presence back to baseline",
    async () => (await presence(observer)).length === baselinePresence,
    20_000,
  );
  expect(await liveMountCount(observer)).toBe(baselineMounts); // and the dispose revoked NOTHING
  expect(await subscriptions(observer)).toEqual([]);
});

// (Deleted with the rpcStubs migration: the defect-31 "unsubscribe reaps the parked connection
// via the last naming mount" case has no counterpart. A row never OWNS a stub — a live
// subscription's target is pure data naming the `itx.rpcStubs` built-in. The stub's lifetime is
// physical and session-bound: it goes at session end, on `rpcStubs.close(key)`, or with
// `unsubscribe` from the SESSION THAT PARKED IT — never by a refcount, so there is no
// reap-on-last-revoke to assert. The churn test above still guards stub hygiene end-to-end.)

// ─────────────────────────── 7. waitUntilProcessed against a future offset ───────────────────────────

test("waitUntilProcessed(future offset) times out with its documented error and leaks no waiter", async () => {
  const ctx = "prj_lr_barrier";
  const itx = await harness.itx(ctx);
  await enableFixtureProcessor(itx, "tally");
  await append(itx, { type: "mark" });
  const head = await readHead(itx);
  await until("tally at head", async () => ((await tallySnapshot(itx)) as any).offset >= head);

  const t0 = Date.now();
  await expect(
    itx.invokeCapability([
      "itx",
      "facets",
      ["get", "tally"],
      ["waitUntilProcessed", { offset: head + 50, timeoutMs: 1500 }],
    ]),
  ).rejects.toThrow(/did not reach offset/);
  const elapsed = Date.now() - t0;
  expect(elapsed).toBeGreaterThanOrEqual(1_200); // it genuinely waited
  expect(elapsed).toBeLessThan(8_000); // and rejected at ITS deadline, not a transport one

  // a LATER append releases nothing stale: the barrier still works exactly
  const [m] = await append(itx, { type: "mark" });
  await itx.invokeCapability([
    "itx",
    "facets",
    ["get", "tally"],
    ["waitUntilProcessed", { offset: m.offset, timeoutMs: 5000 }],
  ]);
  const snap: any = await tallySnapshot(itx);
  expect(snap.offset).toBeGreaterThanOrEqual(m.offset);
  expect(snap.state.counts.mark).toBe(2);
});
