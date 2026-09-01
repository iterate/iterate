// facet1.e2e.test.ts — THE FACET SPINE live: a processor in a real workerd facet on the Stream DO.
// enable(tally) → events land (capability-provided/revoked from mounts) → the facet folds them →
// snapshot through the parent. Also proves COLD CATCH-UP (an event appended BEFORE enable is
// counted) and configure-durability across appends.
// (was proofs/prove_facet1.mjs)

import { expect, test } from "vitest";
import { freshCtx, bareItx, facetProcessorSlugs } from "./support/client.ts";

test("facet spine: cold catch-up + driven folds + the table lists the facet processor", async () => {
  const itx = bareItx(freshCtx("facet"));

  // one mount BEFORE enabling — the facet must count it via cold catch-up
  await itx.provide("itx.before", "itx.kv");

  await itx.enableProcessor("tally");
  const s1 = await itx.invokeCapability("itx.facets.get('tally').snapshot()");
  // cold catch-up: pre-enable events counted (incl. tally's own enablement mount)
  // TWO provided events by now: the itx.before mount AND tally's own enablement mount
  // (enablement is a mount since increment 55 — event-sourced like every attachment)
  expect(s1.state?.counts?.["events.iterate.com/capability-table/capability-provided"]).toBe(2);

  // two more mounts + one revoke AFTER enabling — the drive path
  const p2 = await itx.provide("itx.a", "itx.kv");
  await itx.provide("itx.b", "itx.kv");
  await itx.revoke({ providedAtOffset: p2.providedAtOffset });

  const s2 = await itx.invokeCapability("itx.facets.get('tally').snapshot()");
  // facet folds driven events (4 provided incl. enablement + 1 revoked). The cursor sits at or past
  // the 5 durable events — live-state deltas are ephemerals in the SAME offset space, so the exact
  // position depends on how many the default-on projection emitted; the counts pin the real fold.
  expect(s2.state?.counts?.["events.iterate.com/capability-table/capability-provided"]).toBe(4);
  expect(s2.state?.counts?.["events.iterate.com/capability-table/capability-revoked"]).toBe(1);
  expect(s2.offset).toBeGreaterThanOrEqual(5);

  // the capability table lists the facet processor (was /state → hostState() → the table's
  // facet-lane rows — a processor IS a subscriber mount)
  const slugs = await facetProcessorSlugs(itx);
  expect(Array.isArray(slugs)).toBe(true);
  expect(slugs).toContain("tally");
});
