// stream-woken-and-inline-live-state.e2e.test.ts — the WAKE RECORD + inline live state, LIVE: a fresh stream's first commit
// carries events.iterate.com/stream/woken at offset 1 (the platform's own record, injected by
// Stream.append — never echoed as a receipt), the core processor reduces it into
// `state.incarnation`, and the INLINE reduced states (core, capability-table) emit the standard
// ephemeral live-state/changed deltas on change, delivered to a subscriber that names the one
// live-state event type — exactly like any facet processor's.

import { expect, test } from "vitest";
import { freshCtx, openItx, until } from "./support/client.ts";
import { deltasFor, LIVE_STATE_CHANGED, type Delta } from "./support/live-client.ts";

test("first append commits the woken event first; core's reduced state carries the incarnation", async () => {
  const itx = openItx(freshCtx("woken"));
  const receipts = await itx.invokeCapability(`itx.append({ type: 'hello' })`);
  // one receipt per INPUT — the wake record is the platform's, not the caller's
  expect(receipts).toHaveLength(1);
  expect(receipts[0].type).toBe("hello");

  const page = await itx.invokeCapability("itx.read(0)");
  expect(page.events[0].type).toBe("events.iterate.com/stream/woken");
  expect(page.events[0].offset).toBe(1);
  const incarnation = page.events[0].payload.incarnation;
  expect(typeof incarnation).toBe("number");
  expect(incarnation).toBeGreaterThanOrEqual(1);

  // the core reduce folded it — runtime state IS reduced state
  const snap = await itx.invokeCapability("itx.facets.get('core').snapshot()");
  expect(snap.state.incarnation).toBe(incarnation);

  // exactly once per incarnation
  await itx.invokeCapability(`itx.append({ type: 'again' })`);
  const page2 = await itx.invokeCapability("itx.read(0)");
  expect(
    page2.events.filter((e: { type: string }) => e.type === "events.iterate.com/stream/woken"),
  ).toHaveLength(1);
});

test("inline reduced states are live: capability-table and core changes reach a live-state subscriber", async () => {
  const itx = openItx(freshCtx("inlinelive"));
  await itx.invokeCapability(`itx.append({ type: 'seed' })`);

  // ONE event type carries every key's deltas; each watcher keeps its key (deltasFor)
  const tableDeltas: Delta[] = [];
  const coreDeltas: Delta[] = [];
  await itx.subscribe({
    name: "tablewatch",
    target: deltasFor({ consume: (d) => tableDeltas.push(d) }, "capability-table"),
    consumes: [LIVE_STATE_CHANGED],
  });
  await itx.subscribe({
    name: "corewatch",
    target: deltasFor({ consume: (d) => coreDeltas.push(d) }, "core"),
    consumes: [LIVE_STATE_CHANGED],
  });

  // a capability-table change (a provide) → a delta keyed "capability-table"
  await itx.provide("itx.zzz", "itx.whoami");
  const tableDelta = await until("capability-table delta", () =>
    tableDeltas.find((d) => d.key === "capability-table"),
  );
  expect(typeof tableDelta.from).toBe("number");
  expect(tableDelta.to).toBe(tableDelta.from + 1); // each emission chains its producer revision
  expect(Array.isArray(tableDelta.patch)).toBe(true);

  // a core change (breaker reconfigure) → a delta keyed "core"
  await itx.invokeCapability(
    `itx.append({ type: 'events.iterate.com/stream/breaker-configured', payload: { capacity: 100, refillPerSecond: 1 } })`,
  );
  const coreDelta = await until("core delta", () => coreDeltas.find((d) => d.key === "core"));
  expect(coreDelta.to).toBe(coreDelta.from + 1);
  expect(Array.isArray(coreDelta.patch)).toBe(true);
});
