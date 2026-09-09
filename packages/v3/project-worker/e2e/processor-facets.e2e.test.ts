// processor-facets.e2e.test.ts — THE FACET SPINE live: a processor is a userspace pure `StreamProcessor`
// hosted by its one-line `StreamProcessorDurableObject` subclass in a real workerd facet on the context
// DO (there are no built-in processors — `tally`, `user-tally`, `breaker` are fixture sources in
// e2e/support/sources.ts). ENABLEMENT is a subscription row whose target is the facet's
// processEventBatch (`enableProcessor` is sugar over exactly that event; identity rides `ctx.props`
// at materialization — rebuild-from-log is true). Pins:
//   • cold catch-up (an event appended BEFORE enable is counted), driven reduces, the subscriptions
//     table listing the processor (ONE row, `hostedFacet`, the source elided, NO cursor — a facet owns
//     its progress); the facet ADDRESS through the built-in, through a rule of its own, the barrier
//     verb, a name the facet does not expose rejecting raw; two userspace processors side by side
//   • the door's refusals: a dotted name, no source, the core reduce's name at either door (core's
//     slice names `rewrite-rules` / `subscriptions` are ordinary facet names)
//   • the raw event-sourced door agrees with the verb, both ways: a hand-appended
//     subscription-configured IS the enablement; `{ target: null }` deletes the hosted facet, storage
//     included, and a re-enable rebuilds from the log
//   • a two-session enable race yields ONE lineage with exact counts; re-enable while WARM appends ONE
//     more configured event (same name REPLACES the row, no dedupe) and never corrupts the reduce;
//     double-enable then ONE disable disables (no enablement stack)
//   • `waitUntilProcessed(future offset)` times out with its documented error and leaks no waiter
//   • POLICY IS A FACET PROCESSOR: the token-bucket breaker (`SOURCES.breaker` — a pure reduce spending
//     one token per durable non-control event, refilled from the EVENT's createdAt, replayable) trips
//     exactly on the crossing by appending `stream/paused` with its reason and provenance; core knows
//     nothing about breakers (the pause check reads the reduced `paused` slice); appends then refuse
//     STREAM_PAUSED; an operator's plain `stream/resumed` restores flow
// (The two pins that read the worker's console — a quiet enable is clean, disable mid-drive raises no
// error storm — are push-delivery-no-dropped-warns.e2e, which owns a worker of its own; a stale
// subscribe handle's compare-and-set undo is __workers-tests__/do-doors.test.ts.)

import { expect, test } from "vitest";
import {
  append,
  codeOf,
  freshCtx,
  openItx,
  processorNames,
  readAll,
  readHead,
  rejection,
  subscriptions,
  until,
} from "./support/client.ts";
import { enableFixtureProcessor, SOURCES } from "./support/sources.ts";

// ── the spine: reduces and the facet address ──

/** ONE event type for the rewrite-rule table: a set and an un-set (`target: null`) alike. */
const RULE_CONFIGURED = "events.iterate.com/itx/rewrite-rule-configured";
const CONFIGURED = "events.iterate.com/stream/subscription-configured";

test("facet spine: cold catch-up + driven reduces + the subscriptions table lists the processor", async () => {
  const itx = openItx(freshCtx("facet"));

  // one rewrite rule BEFORE enabling — the facet must count it via cold catch-up
  await itx.provide("itx.before", "itx.kv");

  await enableFixtureProcessor(itx, "tally");
  const s1 = await itx.invoke("itx.facets.get('tally').snapshot()");
  // cold catch-up: the pre-enable rule is counted, and so are TWO subscription-configured events —
  // the birth `config` funnel (auto-subscribed in the DO constructor) and tally's own enablement.
  // Both are subscriptions, NOT rewrite rules (an enablement is a subscription).
  expect(s1.state?.counts?.[RULE_CONFIGURED]).toBe(1);
  expect(s1.state?.counts?.[CONFIGURED]).toBe(2);

  // two more rules + one un-set AFTER enabling — the push path
  await itx.provide("itx.a", "itx.kv");
  await itx.provide("itx.b", "itx.kv");
  await itx.provide("itx.a", null);

  const s2 = await itx.invoke("itx.facets.get('tally').snapshot()");
  // the facet reduces the pushed events (3 sets + 1 un-set, all rewrite-rule-configured). Its
  // checkpoint sits at or past the 8 durable events (created, woken, config, before, configured, a,
  // b, a-unset) — live-state deltas are ephemerals in the SAME offset space, so the exact position
  // depends on how many the core reduce emitted; the counts pin the real reduce.
  expect(s2.state?.counts?.[RULE_CONFIGURED]).toBe(4);
  expect(s2.offset).toBeGreaterThanOrEqual(8);

  // the subscriptions table lists the processor: ONE row whose target is the facet's
  // processEventBatch, and NO cursor — the facet keeps its own checkpoint. M1: the SOURCE is elided
  // from the reduced target (it lives in the log + the facet's kv memo); the row carries a
  // `hostedFacet` marker with the class instead.
  expect(await processorNames(itx)).toEqual(["tally"]);
  const row = (await subscriptions(itx)).find((r: { name: string }) => r.name === "tally");
  expect(row.target).toBe("itx.builtins.facets.get('tally').processEventBatch"); // the platform's spelling, minus the source
  expect(row.hostedFacet).toEqual({ name: "tally", className: "TallyDurableObject" });
  expect(row.cursor).toBeUndefined();
});

test("facet address: the built-in door, a rewrite rule onto it, barrier verb, probe-resistance", async () => {
  const itx = openItx(freshCtx("addr"));
  await enableFixtureProcessor(itx, "tally");
  await itx.invoke(`itx.append({ type: 'mark' })`);

  // 1. a facet method through the `facets` built-in
  const snap = await itx.invoke(`itx.facets.get('tally').snapshot()`);
  expect(snap?.state?.counts?.mark).toBe(1);

  // 2. the barrier verb through the same address — its resolving without throwing IS the proof
  await itx.invoke(`itx.facets.get('tally').waitUntilProcessed({ offset: 1, timeoutMs: 5000 })`);

  // 3. a userspace REWRITE RULE onto the facet address (the address is an ordinary expression)
  await itx.provide("itx.counts", "itx.facets.get('tally')");
  const rewritten = await itx.invoke(["itx", "counts", ["snapshot"]]);
  expect(rewritten?.state?.counts?.mark).toBe(1);
  await itx.provide("itx.counts", null);

  // 4. the facets.get(slug).snapshot() address still answers
  const sugar = await itx.invoke("itx.facets.get('tally').snapshot()");
  expect(sugar?.state?.counts?.mark).toBe(1);

  // 5. a name the facet does not expose rejects — in the RPC receiver's own words (no probe-defense
  //    layer in between: trusted clients, dispatch.ts)
  await expect(itx.invoke(`itx.facets.get('tally').toString()`)).rejects.toThrow();
});

test("two userspace facet processors reduce side-by-side — user-tally and tally", async () => {
  const itx = openItx(freshCtx("ufacet"));

  // both classes arrive via the loader from their INLINE source — the one way to host a processor
  await enableFixtureProcessor(itx, "user-tally");
  await enableFixtureProcessor(itx, "tally");

  // 2 rule sets + 1 un-set
  await itx.provide("itx.a", "itx.kv");
  await itx.provide("itx.b", "itx.kv");
  await itx.provide("itx.a", null);

  // Both reduce the same 8 durable events (created, woken, 3 configured, 3 rewrite-rule-configured):
  // an enablement is a subscription-configured event, not a rewrite rule, so rule events = 3. The 3
  // configured are the birth `config` funnel plus each processor's own enablement.
  // Checkpoints sit at or past offset 8 (live-state deltas share the offset space).
  const su = await itx.invoke("itx.facets.get('user-tally').snapshot()");
  expect(su.state?.counts?.[RULE_CONFIGURED]).toBe(3);
  expect(su.offset).toBeGreaterThanOrEqual(8);

  const sb = await itx.invoke("itx.facets.get('tally').snapshot()");
  expect(sb.state?.counts?.[RULE_CONFIGURED]).toBe(3);
  expect(sb.offset).toBeGreaterThanOrEqual(8);
  expect(sb.state.counts).toEqual(su.state.counts); // the same reduce over the same log

  // the subscriptions table lists both processors (rows whose target is a facet's processEventBatch)
  expect((await processorNames(itx)).sort()).toEqual(["tally", "user-tally"]);
});

// ── enablement is a row: the doors, the lineage, the barrier ──

const tallySnapshot = async (itx: any): Promise<any> =>
  itx.invoke("itx.facets.get('tally').snapshot()");
/** The config-worker funnel auto-subscribes `config` in the DO constructor, so EVERY context is born
 *  holding exactly this subscription row (`configuredAtOffset` 4 — offsets 3 and 5 are ephemeral core
 *  live-state deltas). Its `cursor.confirmedOffset` floats with live delivery, so it is not pinned; a
 *  "nothing the test left behind" table now holds this one birth row, never []. */
const BIRTH_CONFIG_SUBSCRIPTION = {
  name: "config",
  target: "itx.cd('/').worker.processEventBatch",
  consumes: ["*"],
  configuredAtOffset: 4,
  cursor: expect.objectContaining({ attempt: 0 }),
};
/** Expected tally counts = groupBy(type) over the DURABLE log (tally consumes "*", durable only). */
const durableCountsByType = (events: any[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  return counts;
};

// ── the door's refusals ──

test("enableProcessor rejects a name that is not ONE segment (a dotted name)", async () => {
  // A processor's name is its facet name, its subscription name, its `.get(name)` name — ONE
  // segment ([A-Za-z0-9_-]+). "a.b" is refused at the door instead of being re-segmented by a path
  // grammar into an orphan no delivery would ever reach.
  const itx = openItx(freshCtx("dotname"));
  await expect(
    (async () => {
      await itx.enableProcessor("a.b", {
        source: SOURCES.tally,
        className: "TallyDurableObject",
      });
    })(),
  ).rejects.toThrow(/one segment/);
  expect(await subscriptions(itx)).toEqual([BIRTH_CONFIG_SUBSCRIPTION]); // nothing landed beyond the birth config
});

test("enableProcessor REQUIRES a source ref — there are no built-in processors to name", async () => {
  const itx = openItx(freshCtx("nosource"));
  await expect(
    (async () => {
      await itx.enableProcessor("no-such-builtin");
    })(),
  ).rejects.toThrow();
  expect(await subscriptions(itx)).toEqual([BIRTH_CONFIG_SUBSCRIPTION]); // only the birth config
});

test("the core reduce's name is refused at BOTH doors — never a facet to enable or disable; the names of core's slices (rewrite-rules, subscriptions) are ordinary facet names", async () => {
  // `core` is THE inline reduce — always on, never a facet — and its address
  // (`itx.facets.get('core')`) is taken, so its name is refused at both doors: a processor that ran
  // under it could never be addressed or disabled by name. Nothing else is reserved: core's slices
  // have no facet address of their own, so `rewrite-rules` and `subscriptions` are plain names a
  // processor may take, address and drop like any other.
  const itx = openItx(freshCtx("inline"));
  expect((await rejection(itx.disableProcessor("core"))).message).toMatch(/core reduce/);
  await expect(
    (async () => {
      await itx.enableProcessor("core", {
        source: SOURCES.tally,
        className: "TallyDurableObject",
      });
    })(),
  ).rejects.toThrow(/core reduce/);
  for (const name of ["rewrite-rules", "subscriptions"]) {
    await itx.enableProcessor(name, {
      source: SOURCES.tally,
      className: "TallyDurableObject",
    });
    const [mark] = await append(itx, { type: "mark", payload: { name } });
    const snap: any = await until(`${name} reduced the mark`, async () => {
      const s: any = await itx
        .invoke(`itx.facets.get('${name}').snapshot()`)
        .catch(() => undefined); // NO_FACET while it materializes
      return s && s.offset >= mark.offset && s;
    });
    expect(snap.state.counts.mark).toBeGreaterThanOrEqual(1); // a tally, addressed under a core slice's name
    await itx.disableProcessor(name);
    await expect(itx.invoke(`itx.facets.get('${name}').snapshot()`)).rejects.toThrow(/no facet/);
  }
  expect(await subscriptions(itx)).toEqual([BIRTH_CONFIG_SUBSCRIPTION]); // only the birth config remains
});

// ── the row IS the enablement ──

test("the raw event-sourced door agrees with the verb — a hand-appended subscription-configured naming the facet's processEventBatch IS the enablement", async () => {
  const itx = openItx(freshCtx("rawdoor"));
  await append(itx, {
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      name: "tally",
      target: [
        "itx",
        "facets",
        ["get", "tally", { source: SOURCES.tally, className: "TallyDurableObject" }],
        "processEventBatch",
      ],
    },
  });
  expect(await processorNames(itx)).toEqual(["tally"]); // listed as enabled — and it is
  const [mark] = await append(itx, { type: "mark" });
  const snap: any = await until("tally reduced the mark", async () => {
    const s: any = await tallySnapshot(itx).catch(() => undefined); // NO_FACET while it materializes
    return s && s.offset >= mark.offset && s;
  });
  expect(snap.state.counts.mark).toBe(1);
});

test("enableProcessor('tally') from two sessions concurrently: one effective lineage, exact counts, the table lists tally once", async () => {
  const ctx = freshCtx("dualenable");
  const itxA = openItx(ctx);
  const itxB = openItx(ctx);
  await Promise.all([enableFixtureProcessor(itxA, "tally"), enableFixtureProcessor(itxB, "tally")]);

  // same name REPLACES (no stack, no dedupe): the racing enables landed TWO configured events, and
  // the table holds ONE row named tally
  expect((await processorNames(itxA)).filter((s) => s === "tally")).toHaveLength(1);

  for (let i = 0; i < 3; i++) await append(itxA, { type: "seen", payload: { i } });
  const head = await readHead(itxA);
  const expected = durableCountsByType(await readAll(itxA));
  expect(expected["events.iterate.com/stream/subscription-configured"]).toBe(3); // one per enable (2) + the birth config subscription — the verb is literally "append the event"
  const snap = await until("tally reduced the whole log exactly once", async () => {
    const s: any = await tallySnapshot(itxA);
    return s.offset >= head && s;
  });
  // one lineage: bit-exact counts (a doubled drive or a second lineage would overcount; a
  // dropped one would undercount)
  expect(snap.state.counts).toEqual(expected);
  expect(snap.state.counts.seen).toBe(3);
});

test("re-enable while WARM appends ONE more configured event (same name REPLACES the row) and never corrupts the reduce (no reset, no double-count)", async () => {
  const itx = openItx(freshCtx("reenable"));
  await enableFixtureProcessor(itx, "tally");
  await append(itx, { type: "mark" });
  await append(itx, { type: "mark" });
  const head1 = await readHead(itx);
  const s1: any = await until("tally at head", async () => {
    const s: any = await tallySnapshot(itx);
    return s.offset >= head1 && s;
  });
  expect(s1.state.counts.mark).toBe(2);

  const configuredEvents = async () =>
    (await readAll(itx)).filter(
      (e) => e.type === "events.iterate.com/stream/subscription-configured",
    ).length;
  const configuredBefore = await configuredEvents();
  await enableFixtureProcessor(itx, "tally"); // the same row again ⇒ ONE more configured event (no dedupe); the map entry is replaced
  expect(await configuredEvents()).toBe(configuredBefore + 1);
  expect((await processorNames(itx)).filter((s) => s === "tally")).toHaveLength(1);
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

test("double-enable then ONE disableProcessor disables it (same name REPLACES — there is no enablement stack to clear)", async () => {
  const itx = openItx(freshCtx("disshadow"));
  await enableFixtureProcessor(itx, "tally");
  await enableFixtureProcessor(itx, "tally"); // re-enable while WARM (supported: one more configured event replaces the row)
  await append(itx, { type: "mark" });
  const head = await readHead(itx);
  await until("tally at head", async () => ((await tallySnapshot(itx)) as any).offset >= head);

  await itx.disableProcessor("tally"); // ONE disable

  expect(await processorNames(itx)).not.toContain("tally");
  expect(await subscriptions(itx)).toEqual([BIRTH_CONFIG_SUBSCRIPTION]); // only the birth config remains
  await expect(tallySnapshot(itx)).rejects.toThrow(/no facet.*"tally"/);
});

// ── the barrier ──

test("waitUntilProcessed(future offset) times out with its documented error and leaks no waiter", async () => {
  const itx = openItx(freshCtx("barrier"));
  await enableFixtureProcessor(itx, "tally");
  await append(itx, { type: "mark" });
  const head = await readHead(itx);
  await until("tally at head", async () => ((await tallySnapshot(itx)) as any).offset >= head);

  const t0 = Date.now();
  await expect(
    itx.invoke([
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
  await itx.invoke([
    "itx",
    "facets",
    ["get", "tally"],
    ["waitUntilProcessed", { offset: m.offset, timeoutMs: 5000 }],
  ]);
  const snap: any = await tallySnapshot(itx);
  expect(snap.offset).toBeGreaterThanOrEqual(m.offset);
  expect(snap.state.counts.mark).toBe(2);
});

// ── the row's removal IS the disablement ──

test("the raw event agrees with disableProcessor — a hand-appended subscription-configured { target: null } deletes the facet the row HOSTED, storage included", async () => {
  const itx = openItx(freshCtx("rawdisable"));
  await enableFixtureProcessor(itx, "tally");
  const [mark] = await append(itx, { type: "mark" });
  await until("tally reduced the mark", async () => {
    const s: any = await tallySnapshot(itx).catch(() => undefined);
    return s && s.offset >= mark.offset && s;
  });
  // ONE event, no verb: the DO deletes the hosted facet before the append returns
  await append(itx, {
    type: "events.iterate.com/stream/subscription-configured",
    payload: { name: "tally", target: null },
  });
  expect(await processorNames(itx)).toEqual([]);
  await expect(tallySnapshot(itx)).rejects.toThrow(/no facet/);
  // a re-enable is a clean rebuild from the log (the mark above is counted once, from offset 0)
  await enableFixtureProcessor(itx, "tally");
  const rebuilt: any = await until("tally rebuilt from the log", async () => {
    const s: any = await tallySnapshot(itx).catch(() => undefined);
    return s && s.offset >= mark.offset && s;
  });
  expect(rebuilt.state.counts.mark).toBe(1);
});

// ── policy as a facet processor: the breaker pauses the stream ──

const PAUSED = "events.iterate.com/stream/paused";

test("a burst past the breaker's capacity pauses the stream (the facet appends `paused` with its reason); appends refuse with STREAM_PAUSED; an operator's `resumed` restores flow", async () => {
  const itx = openItx(freshCtx("breaker"));
  // enableProcessor("breaker", { source: SOURCES.breaker, className: "BreakerDurableObject" })
  await enableFixtureProcessor(itx, "breaker");
  // The breaker's own enablement (subscription-configured) is a durable non-control event: the bucket
  // (capacity 5) is at 4 once it has reduced its own row. Nothing paused yet.
  await append(itx, { type: "warm" }); // 3 left
  expect((await readAll(itx)).some((e) => e.type === PAUSED)).toBe(false);

  // ONE batch of 8 durable events — more than the bucket holds. The crossing happens mid-batch; the
  // breaker's processEvent trips exactly once (the crossing), appending `paused`.
  const burst = await append(
    itx,
    ...Array.from({ length: 8 }, (_, i) => ({ type: "burst", payload: { i } })),
  );
  expect(burst).toHaveLength(8); // the burst itself was admitted — policy reads the REDUCE, after the commit
  const paused = await itx.waitForEvent({ type: PAUSED, afterOffset: 0, timeoutMs: 20_000 });
  expect(paused.payload).toEqual({ reason: "breaker: durable events exceeded the bucket" });
  // provenance: the engine stamps every processor emit with its slug — the log says WHO paused it
  expect(paused.source?.processor).toMatchObject({ slug: "breaker", version: "1.0.0" });
  expect(paused.source?.processor?.whileProcessing?.type).toBe("burst");
  expect(paused.idempotencyKey).toMatch(/^breaker\/trip@\d+$/); // a replay can never double-pause

  // the stream is paused: a further append refuses at the door, coded, with the breaker's reason
  const err = await rejection(append(itx, { type: "more" }));
  expect(codeOf(err)).toBe("STREAM_PAUSED");
  expect(err.message).toContain("stream paused: breaker: durable events exceeded the bucket");
  // the core snapshot shows the same truth
  const core = await itx.invoke("itx.facets.get('core').snapshot()");
  expect(core.state.paused).toEqual({ reason: "breaker: durable events exceeded the bucket" });

  // the operator's recovery is a plain control append — resume always lands on a paused stream
  await append(itx, { type: "events.iterate.com/stream/resumed" });
  const [after] = await append(itx, { type: "after" });
  expect(after.offset).toBeGreaterThan(paused.offset); // flow restored
  // the bucket is in debt (no second crossing) — the ONE trip is the only `paused` in the log
  expect((await readAll(itx)).filter((e) => e.type === PAUSED)).toHaveLength(1);
  // and the breaker's reduced state is the pure reduce of the log: tokens below zero, replayable
  const snap = await itx.invoke("itx.facets.get('breaker').snapshot()");
  expect(snap.state.tokens).toBeLessThan(0);
  expect(snap.state.lastAtMs).toBeGreaterThan(0);
});
