// processor-facet-enable-disable-lineage.e2e.test.ts — processor ENABLEMENT is a subscription row
// whose target is the facet's processEventBatch (`enableProcessor` is sugar over exactly that
// event; identity rides `ctx.props` at materialization — rebuild-from-log is true). Proves the
// door's refusals (a dotted name, no source, the core reduce's name on either door), that the raw
// event-sourced door agrees with the verb, one effective lineage under a two-session enable race,
// re-enable while WARM as ONE more configured event (the row is a MAP entry — same name REPLACES,
// no dedupe) that never corrupts the reduce, double-enable + ONE disable (no enablement stack), and
// the waitUntilProcessed barrier against a future offset. (The two pins that read the worker's
// console — a quiet enable is clean, disable mid-drive raises no error storm — live in
// push-delivery-no-dropped-warns.e2e.)

import { expect, test } from "vitest";
import {
  append,
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

const tallySnapshot = async (itx: any): Promise<any> =>
  itx.invoke("itx.facets.get('tally').snapshot()");
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
  expect(await subscriptions(itx)).toEqual([]); // nothing landed
});

test("enableProcessor REQUIRES a source ref — there are no built-in processors to name", async () => {
  const itx = openItx(freshCtx("nosource"));
  await expect(
    (async () => {
      await itx.enableProcessor("no-such-builtin");
    })(),
  ).rejects.toThrow();
  expect(await subscriptions(itx)).toEqual([]);
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
  expect(await subscriptions(itx)).toEqual([]);
});

// ── the row IS the enablement ──

test("the raw event-sourced door agrees with the verb — a hand-appended subscription-configured naming the facet's processEventBatch IS the enablement", async () => {
  const itx = openItx(freshCtx("rawdoor"));
  await append(itx, {
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      name: "tally",
      target: `itx.facets.get('tally', { source: ${JSON.stringify(SOURCES.tally)}, className: 'TallyDurableObject' }).processEventBatch`,
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
  expect(expected["events.iterate.com/stream/subscription-configured"]).toBe(2); // one per enable — the verb is literally "append the event"
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
  expect(await subscriptions(itx)).toEqual([]);
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
