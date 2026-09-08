// processor-facet-reduces-and-address.e2e.test.ts — THE FACET SPINE live: a processor is a userspace
// pure `StreamProcessor` (`TallyProcessor`) hosted by its one-line `StreamProcessorDurableObject` subclass
// (`TallyDurableObject`) in a real workerd facet on the context DO (there are no built-in processors —
// `tally` is a fixture source like any other). enableFixtureProcessor(tally) → events land → the facet
// reduces them → snapshot through the parent. Proves COLD CATCH-UP (an event appended BEFORE enable is
// counted), that the subscriptions table lists the processor (a processor IS a subscription whose
// target is a facet's processEventBatch — no separate machinery, no cursor: a facet owns its
// progress), same-name-replaces (no shadow stack), the facet ADDRESS (any facet method through the
// rewrite rules, reachable through a rule of its own, the barrier verb, probe-resistant), and two
// userspace processors reducing side by side.

import { expect, test } from "vitest";
import { freshCtx, openItx, processorNames, subscriptions } from "./support/client.ts";
import { enableFixtureProcessor } from "./support/sources.ts";

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
