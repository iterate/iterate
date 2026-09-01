// userfacet.e2e.test.ts — TWO userspace facet processors side by side: user-tally and tally are both
// loader-loaded StreamProcessorDurableObject subclasses hosted as workerd facets on the context DO
// (there are no built-in processors — tally is a fixture source like any other). enable both →
// 2 provides + 1 revoke → both facets fold identically (counts + own checkpoint past the last event).
// (was proofs/prove_userfacet.mjs)

import { expect, test } from "vitest";
import { freshCtx, openItx, processorNames } from "./support/client.ts";
import { enableFixtureProcessor } from "./support/sources.ts";

const PROVIDED = "events.iterate.com/capability-table/capability-provided";
const REVOKED = "events.iterate.com/capability-table/capability-revoked";

test("two userspace facet processors fold side-by-side — user-tally and tally", async () => {
  const itx = openItx(freshCtx("ufacet"));

  // both classes arrive via the loader from a seeded source expression — the one way to host a processor
  await enableFixtureProcessor(itx, "user-tally");
  await enableFixtureProcessor(itx, "tally");

  // 2 provides + 1 revoke
  const p1 = await itx.provide("itx.a", "itx.kv");
  await itx.provide("itx.b", "itx.kv");
  await itx.revoke({ providedAtOffset: p1.providedAtOffset });

  // Both fold the same 6 durable events (woken, 2 configured, 2 provided, 1 revoked): an enablement
  // is a subscription-configured event, not a mount, so provided = 2. Checkpoints sit at or past
  // offset 6 (live-state deltas share the offset space).
  const su = await itx.invokeCapability("itx.facets.get('user-tally').snapshot()");
  expect(su.state?.counts?.[PROVIDED]).toBe(2);
  expect(su.state?.counts?.[REVOKED]).toBe(1);
  expect(su.offset).toBeGreaterThanOrEqual(6);

  const sb = await itx.invokeCapability("itx.facets.get('tally').snapshot()");
  expect(sb.state?.counts?.[PROVIDED]).toBe(2);
  expect(sb.state?.counts?.[REVOKED]).toBe(1);
  expect(sb.offset).toBeGreaterThanOrEqual(6);
  expect(sb.state.counts).toEqual(su.state.counts); // the same reduce over the same log

  // the subscriptions table lists both processors (rows whose target is a facet's processEventBatch)
  expect((await processorNames(itx)).sort()).toEqual(["tally", "user-tally"]);
});
