// userfacet.e2e.test.ts — USERSPACE facet processors live: a loader-loaded DurableObject class
// (duck-typed configure/deliver/snapshot) hosted as a workerd facet on the Stream DO, side by
// side with the built-in tally facet. enable(user-tally via source expression) + enable(tally)
// → 2 provides + 1 revoke → both facets fold identically (counts + own cursor at offset 3).
// (was proofs/prove_userfacet.mjs)

import { expect, test } from "vitest";
import { freshCtx, openItx, facetProcessorSlugs } from "./support/client.ts";
import { seedSources } from "./support/sources.ts";

test("userspace facet processor folds side-by-side with the built-in tally", async () => {
  const itx = openItx(freshCtx("ufacet"));
  await seedSources(itx, ["user-tally"]);

  // enable the USERSPACE processor (class arrives via the loader from a source expression),
  // and the BUILT-IN tally alongside it
  await itx.enableProcessor("user-tally", {
    source: "itx.kv.get('src/user-tally.js')",
    className: "UserTally",
  });
  await itx.enableProcessor("tally");

  // 2 provides + 1 revoke → offsets 1..3
  const p1 = await itx.provide("itx.a", "itx.kv");
  await itx.provide("itx.b", "itx.kv");
  await itx.revoke({ providedAtOffset: p1.providedAtOffset });

  const su = await itx.invokeCapability("itx.facets.get('user-tally').snapshot()");
  // USERSPACE facet folds (4 provided incl. enablements + 1 revoked @ own cursor 5)
  // 4 provided: the two enablement mounts (user-tally, tally) + the two test mounts
  expect(su.state?.counts?.["events.iterate.com/capability-table/capability-provided"]).toBe(4);
  expect(su.state?.counts?.["events.iterate.com/capability-table/capability-revoked"]).toBe(1);
  // at-or-past the 5 durable events: live-state deltas share the offset space (default-on projection)
  expect(su.offset).toBeGreaterThanOrEqual(5);

  const sb = await itx.invokeCapability("itx.facets.get('tally').snapshot()");
  // BUILT-IN tally still works side-by-side (same reduce @ offset 5)
  expect(sb.state?.counts?.["events.iterate.com/capability-table/capability-provided"]).toBe(4);
  expect(sb.state?.counts?.["events.iterate.com/capability-table/capability-revoked"]).toBe(1);
  expect(sb.offset).toBeGreaterThanOrEqual(5);

  const slugs = await facetProcessorSlugs(itx);
  // the capability table lists both facet processors (facet-lane subscriber rows)
  expect(slugs).toContain("user-tally");
  expect(slugs).toContain("tally");
});
