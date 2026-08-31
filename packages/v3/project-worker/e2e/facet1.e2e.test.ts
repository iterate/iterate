// facet1.e2e.test.ts — THE FACET SPINE live: a processor in a real workerd facet on the Stream DO.
// enable(tally) → events land (capability-provided/revoked from mounts) → the facet folds them →
// snapshot through the parent. Also proves COLD CATCH-UP (an event appended BEFORE enable is
// counted) and configure-durability across appends.
// (was proofs/prove_facet1.mjs)

import { expect, test } from "vitest";
import { freshCtx, bareItx } from "./support/client.ts";

test("facet spine: cold catch-up + driven folds + host state lists the facet processor", async () => {
  const itx = bareItx(freshCtx("facet"));

  // one mount BEFORE enabling — the facet must count it via cold catch-up
  await itx.provide({ path: "itx.before", target: "itx.kv" });

  await itx.enableProcessor("tally");
  const s1 = await itx.invokeCapability("itx.facets.get('tally').snapshot()");
  // cold catch-up: pre-enable events counted (incl. tally's own enablement mount)
  // TWO provided events by now: the itx.before mount AND tally's own enablement mount
  // (enablement is a mount since increment 55 — event-sourced like every attachment)
  expect(s1.state?.counts?.["events.iterate.com/capability-table/capability-provided"]).toBe(2);

  // two more mounts + one revoke AFTER enabling — the drive path
  const p2 = await itx.provide({ path: "itx.a", target: "itx.kv" });
  await itx.provide({ path: "itx.b", target: "itx.kv" });
  await itx.revoke({ providedAtOffset: p2.providedAtOffset });

  const s2 = await itx.invokeCapability("itx.facets.get('tally').snapshot()");
  // facet folds driven events (4 provided incl. enablement + 1 revoked). The cursor sits at or past
  // the 5 durable events — live-state deltas are ephemerals in the SAME offset space, so the exact
  // position depends on how many the default-on projection emitted; the counts pin the real fold.
  expect(s2.state?.counts?.["events.iterate.com/capability-table/capability-provided"]).toBe(4);
  expect(s2.state?.counts?.["events.iterate.com/capability-table/capability-revoked"]).toBe(1);
  expect(s2.offset).toBeGreaterThanOrEqual(5);

  // host state lists the facet processor (was `/state` → itx.hostState())
  const st = await itx.hostState();
  expect(Array.isArray(st.facetProcessors)).toBe(true);
  expect(st.facetProcessors).toContain("tally");
});
