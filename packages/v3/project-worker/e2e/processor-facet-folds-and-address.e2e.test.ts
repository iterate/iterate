// processor-facet-folds-and-address.e2e.test.ts — THE FACET SPINE live: a processor is a userspace
// pure `StreamProcessor` (`TallyProcessor`) hosted by its one-line `StreamProcessorDurableObject` subclass
// (`TallyDurableObject`) in a real workerd facet on the context DO (there are no built-in processors —
// `tally` is a fixture source like any other). enableFixtureProcessor(tally) → events land → the facet
// folds them → snapshot through the parent. Proves COLD CATCH-UP (an event appended BEFORE enable is
// counted), that the subscriptions table lists the processor (a processor IS a subscription whose
// target is a facet's processEventBatch — no separate machinery, no cursor: a facet owns its
// progress), same-name-replaces (no shadow stack), the facet ADDRESS (any facet method through the
// routing table, aliasable, the barrier verb, probe-resistant), and two userspace processors folding
// side by side.

import { expect, test } from "vitest";
import { freshCtx, openItx, processorNames, subscriptions, until } from "./support/client.ts";
import { enableFixtureProcessor } from "./support/sources.ts";

const PROVIDED = "events.iterate.com/capability-table/capability-provided";
const REVOKED = "events.iterate.com/capability-table/capability-revoked";
const CONFIGURED = "events.iterate.com/stream/subscription-configured";

test("facet spine: cold catch-up + driven folds + the subscriptions table lists the processor", async () => {
  const itx = openItx(freshCtx("facet"));

  // one mount BEFORE enabling — the facet must count it via cold catch-up
  await itx.provide("itx.before", "itx.kv");

  await enableFixtureProcessor(itx, "tally");
  const s1 = await itx.invokeCapability("itx.facets.get('tally').snapshot()");
  // cold catch-up: the pre-enable mount is counted, and so is tally's own enablement — which is a
  // subscription-configured event, NOT a mount (an enablement is a subscription, not a capability)
  expect(s1.state?.counts?.[PROVIDED]).toBe(1);
  expect(s1.state?.counts?.[CONFIGURED]).toBe(1);

  // two more mounts + one revoke AFTER enabling — the push path
  const p2 = await itx.provide("itx.a", "itx.kv");
  await itx.provide("itx.b", "itx.kv");
  await itx.revoke({ providedAtOffset: p2.providedAtOffset });

  const s2 = await itx.invokeCapability("itx.facets.get('tally').snapshot()");
  // the facet folds the pushed events (3 provided + 1 revoked). Its checkpoint sits at or past the
  // 7 durable events (created, woken, before, configured, a, b, revoked) — live-state deltas are
  // ephemerals in the SAME offset space, so the exact position depends on how many the core reduce
  // emitted; the counts pin the real fold.
  expect(s2.state?.counts?.[PROVIDED]).toBe(3);
  expect(s2.state?.counts?.[REVOKED]).toBe(1);
  expect(s2.offset).toBeGreaterThanOrEqual(7);

  // the subscriptions table lists the processor: ONE row whose target is the facet's
  // processEventBatch through the load chain, and NO cursor — the facet keeps its own checkpoint
  expect(await processorNames(itx)).toEqual(["tally"]);
  const row = (await subscriptions(itx)).find((r: { name: string }) => r.name === "tally");
  expect(row.target).toMatch(
    /^itx\.load\(.*\)\.getDurableObjectClass\(["']TallyDurableObject["']\)\.get\(["']tally["']\)\.processEventBatch$/,
  );
  expect(row.cursor).toBeUndefined();
});

// An enablement is a subscription, and the SAME NAME REPLACES — there is no shadow stack to pop.
// Enabling twice appends nothing the second time (identical row), and ONE disable turns the
// processor off: the row is gone and the facet is deleted.
test("enable twice, disable once: same name replaces (no shadow stack) — one row, zero extra events, off after one disable", async () => {
  const itx = openItx(freshCtx("facet-twice"));
  await enableFixtureProcessor(itx, "tally");
  const logOnce = await itx.read(0, 500);
  await enableFixtureProcessor(itx, "tally"); // identical subscription ⇒ nothing appended
  const logTwice = await itx.read(0, 500);
  expect(logTwice.events.length).toBe(logOnce.events.length);
  expect(await processorNames(itx)).toEqual(["tally"]);

  await itx.append({ type: "mark" });
  await until("tally counted the mark", async () => {
    const s = await itx.invokeCapability("itx.facets.get('tally').snapshot()");
    return s.state?.counts?.mark === 1 ? s : undefined;
  });

  await itx.disableProcessor("tally"); // ONE disable
  expect(await processorNames(itx)).toEqual([]);
  await expect(itx.invokeCapability("itx.facets.get('tally').snapshot()")).rejects.toThrow(
    /no facet/,
  );
  // a later mark reaches no processor — nothing re-materializes a disabled facet
  await itx.append({ type: "mark" });
  await expect(itx.invokeCapability("itx.facets.get('tally').snapshot()")).rejects.toThrow(
    /no facet/,
  );
});

test("facet address: table routing, alias/shadow, barrier verb, probe-resistance", async () => {
  const itx = openItx(freshCtx("addr"));
  await enableFixtureProcessor(itx, "tally");
  await itx.invokeCapability(`itx.append({ type: 'mark' })`);

  // 1. a facet method through the table
  const snap = await itx.invokeCapability(`itx.facets.get('tally').snapshot()`);
  expect(snap?.state?.counts?.mark).toBe(1);

  // 2. the barrier verb through the same address — its resolving without throwing IS the proof
  await itx.invokeCapability(
    `itx.facets.get('tally').waitUntilProcessed({ offset: 1, timeoutMs: 5000 })`,
  );

  // 3. userspace ALIAS + shadow-stack (the address is an ordinary capability)
  const prov = await itx.provide("itx.counts", "itx.facets.get('tally')");
  const aliased = await itx.invokeCapability(["itx", "counts", ["snapshot"]]);
  expect(aliased?.state?.counts?.mark).toBe(1);
  await itx.revoke(prov);

  // 4. the facets.get(slug).snapshot() address still answers
  const sugar = await itx.invokeCapability("itx.facets.get('tally').snapshot()");
  expect(sugar?.state?.counts?.mark).toBe(1);

  // 5. probe-resistance carries over: inherited built-ins unreachable on the facet
  await expect(itx.invokeCapability(`itx.facets.get('tally').toString()`)).rejects.toThrow(
    /is not a method/,
  );
});

test("two userspace facet processors fold side-by-side — user-tally and tally", async () => {
  const itx = openItx(freshCtx("ufacet"));

  // both classes arrive via the loader from a seeded source expression — the one way to host a processor
  await enableFixtureProcessor(itx, "user-tally");
  await enableFixtureProcessor(itx, "tally");

  // 2 provides + 1 revoke
  const p1 = await itx.provide("itx.a", "itx.kv");
  await itx.provide("itx.b", "itx.kv");
  await itx.revoke({ providedAtOffset: p1.providedAtOffset });

  // Both fold the same 7 durable events (created, woken, 2 configured, 2 provided, 1 revoked): an
  // enablement is a subscription-configured event, not a mount, so provided = 2. Checkpoints sit at
  // or past offset 7 (live-state deltas share the offset space).
  const su = await itx.invokeCapability("itx.facets.get('user-tally').snapshot()");
  expect(su.state?.counts?.[PROVIDED]).toBe(2);
  expect(su.state?.counts?.[REVOKED]).toBe(1);
  expect(su.offset).toBeGreaterThanOrEqual(7);

  const sb = await itx.invokeCapability("itx.facets.get('tally').snapshot()");
  expect(sb.state?.counts?.[PROVIDED]).toBe(2);
  expect(sb.state?.counts?.[REVOKED]).toBe(1);
  expect(sb.offset).toBeGreaterThanOrEqual(7);
  expect(sb.state.counts).toEqual(su.state.counts); // the same reduce over the same log

  // the subscriptions table lists both processors (rows whose target is a facet's processEventBatch)
  expect((await processorNames(itx)).sort()).toEqual(["tally", "user-tally"]);
});
