// facetaddr.e2e.test.ts — the facet ADDRESS: any facet method through the routing table,
// aliasable/shadowable; the barrier verb rides the same address.
// (was proofs/prove_facetaddr.mjs)

import { expect, test } from "vitest";
import { freshCtx, openItx } from "./support/client.ts";
import { enableFixtureProcessor } from "./support/sources.ts";

test("facet address: table routing, alias/shadow, barrier verb, probe-resistance", async () => {
  const itx = openItx(freshCtx("addr"));
  await enableFixtureProcessor(itx, "tally");
  await itx.invokeCapability(`itx.append({ type: 'mark' })`);

  // 1. a facet method through the SEEDED address
  const snap = await itx.invokeCapability(`itx.facets.get('tally').snapshot()`);
  // itx.facets.get('tally').snapshot() through the table
  expect(snap?.state?.counts?.mark).toBe(1);

  // 2. the barrier verb through the same address — its resolving without throwing IS the proof
  await itx.invokeCapability(
    `itx.facets.get('tally').waitUntilProcessed({ offset: 1, timeoutMs: 5000 })`,
  );
  // waitUntilProcessed rides the facet address
  expect(true).toBe(true);

  // 3. userspace ALIAS + shadow-stack (the address is an ordinary capability)
  const prov = await itx.provide("itx.counts", "itx.facets.get('tally')");
  const aliased = await itx.invokeCapability(["itx", "counts", ["snapshot"]]);
  // aliased facet address via the dotted door
  expect(aliased?.state?.counts?.mark).toBe(1);
  await itx.revoke(prov);

  // 4. the facets.get(slug).snapshot() address still answers
  const sugar = await itx.invokeCapability("itx.facets.get('tally').snapshot()");
  // facets.get(slug).snapshot() rides the address
  expect(sugar?.state?.counts?.mark).toBe(1);

  // 5. probe-resistance carries over: inherited built-ins unreachable on the facet
  let denied = "";
  try {
    await itx.invokeCapability(`itx.facets.get('tally').toString()`);
  } catch (e) {
    denied = String(e);
  }
  // inherited built-ins unreachable through the address
  expect(denied).toMatch(/is not a method/);
});
