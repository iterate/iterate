// subscriptions-ephemeral-opt-in.e2e.test.ts — the ephemeral lane: shared offsets, named-type opt-in (a subscription's
// `consumes` NAMING a type opts its ephemerals in — the ONE rule; absent or "*" = every durable event
// and never an ephemeral), appends through the one dispatch door (itx.append).

import { expect, test } from "vitest";
import { freshCtx, openItx, until } from "./support/client.ts";
import { enableFixtureProcessor, seedSources } from "./support/sources.ts";

test("ephemeral lane: a named-type subscription reduces ephemeral chunks, '*' never sweeps them", async () => {
  const itx = openItx(freshCtx("eph"));
  await seedSources(itx, ["chunky"]);

  // 1. chunky consumes ephemeral 'chunk's, so its subscription NAMES them: `enableProcessor` is the
  //    no-filter spelling (every durable event, no ephemeral); a processor that wants ephemerals is
  //    the SAME subscription — a facet's processEventBatch — with `consumes` spelled out. Beside it
  //    the "*" tally: every durable event, never an ephemeral.
  await itx.subscribe({
    name: "chunky",
    target:
      "itx.load(\"itx.kv.get('src/chunky.js')\").getDurableObjectClass('ChunkyDurableObject').get('chunky').processEventBatch",
    consumes: ["chunk", "mark"],
  });
  await enableFixtureProcessor(itx, "tally");

  // 2. durable mark, three ephemeral chunks, another durable mark — all through the one door
  const mark = await itx.invoke(`itx.append({ type: 'mark' })`);
  // durable append via itx.invoke (full expression) — the enablements consume earlier offsets
  expect(Array.isArray(mark)).toBe(true);
  expect(mark[0].offset).toBeGreaterThanOrEqual(1);
  // (no absolute offset pins: chunky's live-state change events interleave on the shared
  //  sequence — assert the shared-sequence INVARIANT instead: strictly increasing offsets)
  let lastOffset = mark[0].offset;
  for (let i = 0; i < 3; i++) {
    const c = await itx.invoke(`itx.append({ type: 'chunk', ephemeral: true })`);
    // ephemeral append i+1 (shared offset sequence, strictly > lastOffset)
    expect(c[0].ephemeral).toBe(true);
    expect(c[0].offset).toBeGreaterThan(lastOffset);
    lastOffset = c[0].offset;
  }
  const [mark2] = await itx.invoke(`itx.append({ type: 'mark' })`);

  // 3. the NAMED subscriber reduced the chunks; "*" saw none; both checkpoints cover the whole window
  // (pushes are fire-and-forget — wait for the reduce to land rather than racing it)
  const chunky = await until("chunky reduced the chunks", async () => {
    const snap = await itx.invoke("itx.facets.get('chunky').snapshot()");
    return snap.state.chunks === 3 && snap.state.marks === 2 ? snap : undefined;
  });
  // named-type subscriber reduced 3 ephemeral chunks + 2 durable marks
  expect(chunky.state.chunks).toBe(3);
  expect(chunky.state.marks).toBe(2);

  const tally = await until("tally caught up to chunky", async () => {
    const snap = await itx.invoke("itx.facets.get('tally').snapshot()");
    return snap.offset >= chunky.offset ? snap : undefined;
  });
  // '*' never sweeps ephemerals — the loop never even pushes them to a subscription that does not name them
  expect(tally.state.counts["chunk"]).toBeUndefined();
  // '*' subscriber saw both durable marks
  expect(tally.state.counts["mark"]).toBe(2);
  // both checkpoints advanced over the SHARED offset sequence (ephemeral offsets included), at or
  // past the last durable mark
  expect(tally.offset).toBeGreaterThanOrEqual(chunky.offset);
  expect(chunky.offset).toBeGreaterThanOrEqual(mark2.offset);
});
