// processor-facet-enable-disable-lineage.e2e.test.ts — processor ENABLEMENT is a subscription row
// whose target is the facet's processEventBatch (`enableProcessor` is sugar over exactly that
// event; identity rides `ctx.props` at materialization — rebuild-from-log is true). Proves the
// door's refusals (a dotted name, no source, an inline reduce's slug on either door), that the raw
// event-sourced door agrees with the verb, one effective lineage under a two-session enable race,
// re-enable while WARM as a log no-op that never corrupts the reduce, double-enable + ONE disable
// (same name REPLACES — no enablement stack), and the waitUntilProcessed barrier against a future
// offset. (The two pins that read the worker's console — a quiet enable is clean, disable
// mid-drive raises no error storm — live in push-delivery-no-dropped-warns.e2e.)

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
import { enableFixtureProcessor, seedSources } from "./support/sources.ts";

const tallySnapshot = async (itx: any): Promise<any> =>
  itx.invokeCapability("itx.facets.get('tally').snapshot()");
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
  await seedSources(itx, ["tally"]);
  await expect(
    (async () => {
      await itx.enableProcessor("a.b", {
        source: "itx.kv.get('src/tally.js')",
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

test("an inline reduce's slug (core / capability-table / subscriptions) is refused at BOTH doors — never a facet to enable or disable", async () => {
  // The inline reduce-only cores are always-on, never facets — an authority boundary. A name
  // collision with the kernel's own reduces would yield a processor that runs but cannot be
  // addressed or disabled by name.
  const itx = openItx(freshCtx("inline"));
  await seedSources(itx, ["tally"]);
  for (const slug of ["core", "capability-table", "subscriptions"]) {
    expect((await rejection(itx.disableProcessor(slug))).message).toMatch(/inline reduce/);
    await expect(
      (async () => {
        await itx.enableProcessor(slug, {
          source: "itx.kv.get('src/tally.js')",
          className: "TallyDurableObject",
        });
      })(),
    ).rejects.toThrow(/inline reduce/);
  }
});

// ── the row IS the enablement ──

test("the raw event-sourced door agrees with the verb — a hand-appended subscription-configured naming the facet's processEventBatch IS the enablement", async () => {
  const itx = openItx(freshCtx("rawdoor"));
  await seedSources(itx, ["tally"]);
  await append(itx, {
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      name: "tally",
      target:
        "itx.load(\"itx.kv.get('src/tally.js')\").getDurableObjectClass('TallyDurableObject').get('tally').processEventBatch",
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

  // same name REPLACES (no stack): whether the racing enables landed one or two configured
  // events, the table holds ONE row named tally
  expect((await processorNames(itxA)).filter((s) => s === "tally")).toHaveLength(1);

  for (let i = 0; i < 3; i++) await append(itxA, { type: "seen", payload: { i } });
  const head = await readHead(itxA);
  const expected = durableCountsByType(await readAll(itxA));
  const configured = expected["events.iterate.com/stream/subscription-configured"];
  expect(configured === 1 || configured === 2).toBe(true); // the door is idempotent, best-effort under a race
  const snap = await until("tally reduced the whole log exactly once", async () => {
    const s: any = await tallySnapshot(itxA);
    return s.offset >= head && s;
  });
  // one lineage: bit-exact counts (a doubled drive or a second lineage would overcount; a
  // dropped one would undercount)
  expect(snap.state.counts).toEqual(expected);
  expect(snap.state.counts.seen).toBe(3);
});

test("re-enable while WARM is a no-op for the log and never corrupts the reduce (no reset, no double-count)", async () => {
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
  await enableFixtureProcessor(itx, "tally"); // identical row ⇒ appends NOTHING (the idempotent door)
  expect(await configuredEvents()).toBe(configuredBefore);
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
  await enableFixtureProcessor(itx, "tally"); // re-enable while WARM (supported, appends nothing)
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
