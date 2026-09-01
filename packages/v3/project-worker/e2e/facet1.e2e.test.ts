// facet1.e2e.test.ts — THE FACET SPINE live: a processor in a real workerd facet on the context DO.
// enableFixtureProcessor(tally) → events land (capability-provided/revoked from mounts, the
// subscription's own configured event) → the facet folds them → snapshot through the parent. Also
// proves COLD CATCH-UP (an event appended BEFORE enable is counted) and that the subscriptions table
// lists the processor — a processor IS a subscription whose target is a facet's processEventBatch,
// no separate processor machinery, and no cursor (a facet owns its progress).
// (was proofs/prove_facet1.mjs)

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
  // 6 durable events (woken, before, configured, a, b, revoked) — live-state deltas are ephemerals
  // in the SAME offset space, so the exact position depends on how many the inline reduces emitted;
  // the counts pin the real fold.
  expect(s2.state?.counts?.[PROVIDED]).toBe(3);
  expect(s2.state?.counts?.[REVOKED]).toBe(1);
  expect(s2.offset).toBeGreaterThanOrEqual(6);

  // the subscriptions table lists the processor: ONE row whose target is the facet's
  // processEventBatch through the load chain, and NO cursor — the facet keeps its own checkpoint
  expect(await processorNames(itx)).toEqual(["tally"]);
  const row = (await subscriptions(itx)).find((r: { name: string }) => r.name === "tally");
  expect(row.target).toMatch(
    /^itx\.load\(.*\)\.getDurableObjectClass\(["']Tally["']\)\.get\(["']tally["']\)\.processEventBatch$/,
  );
  expect(row.cursor).toBeUndefined();
});

// The still-true pin of the deleted disable-shadow.e2e: an enablement is a subscription, and the SAME
// NAME REPLACES — there is no shadow stack to pop. Enabling twice appends nothing the second time
// (identical row), and ONE disable turns the processor off: the row is gone and the facet is deleted.
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
