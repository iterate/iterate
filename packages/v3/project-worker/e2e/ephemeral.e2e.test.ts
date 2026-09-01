// ephemeral.e2e.test.ts — the ephemeral lane: shared offsets, named-type opt-in,
// "*" never sweeps, appends through the routing table (itx.append).
// (was proofs/prove_ephemeral.mjs)

import { expect, test } from "vitest";
import { freshCtx, openItx, until } from "./support/client.ts";
import { seedSources } from "./support/sources.ts";

test("ephemeral lane: named-type folds ephemeral chunks, '*' never sweeps them, misuse is loud", async () => {
  const itx = openItx(freshCtx("eph"));
  await seedSources(itx, ["chunky"]);

  // 1. enable the userspace ephemeral consumer + the built-in "*" tally
  await itx.enableProcessor("chunky", {
    source: "itx.kv.get('src/chunky.js')",
    className: "Chunky",
  });
  await itx.enableProcessor("tally");

  // 2. durable mark, three ephemeral chunks, another durable mark — all through the table
  const mark = await itx.invokeCapability(`itx.append({ type: 'mark' })`);
  // durable append via itx.invoke (full expression) — enablement mounts consume earlier offsets
  expect(Array.isArray(mark)).toBe(true);
  expect(mark[0].offset).toBeGreaterThanOrEqual(1);
  // (no absolute offset pins: chunky's live-state change events interleave on the shared
  //  sequence — assert the shared-sequence INVARIANT instead: strictly increasing offsets)
  let lastOffset = mark[0].offset;
  for (let i = 0; i < 3; i++) {
    const c = await itx.invokeCapability(`itx.append({ type: 'chunk', ephemeral: true })`);
    // ephemeral append i+1 (shared offset sequence, strictly > lastOffset)
    expect(c[0].ephemeral).toBe(true);
    expect(c[0].offset).toBeGreaterThan(lastOffset);
    lastOffset = c[0].offset;
  }
  await itx.invokeCapability(`itx.append({ type: 'mark' })`);

  // 3. the NAMED consumer folded the chunks; "*" saw none; both cursors cover the whole window
  // (drives are fire-and-forget — wait for the reduce to land rather than racing it)
  const chunky = await until("chunky reduced the chunks", async () => {
    const snap = await itx.invokeCapability("itx.facets.get('chunky').snapshot()");
    return snap.state.chunks === 3 && snap.state.marks === 2 ? snap : undefined;
  });
  // named-type consumer folded 3 ephemeral chunks + 2 durable marks
  expect(chunky.state.chunks).toBe(3);
  expect(chunky.state.marks).toBe(2);

  const tally = await until("tally caught up to chunky", async () => {
    const snap = await itx.invokeCapability("itx.facets.get('tally').snapshot()");
    return snap.offset >= chunky.offset ? snap : undefined;
  });
  // '*' never sweeps ephemerals
  expect(tally.state.counts["chunk"]).toBeUndefined();
  // '*' consumer saw both durable marks
  expect(tally.state.counts["mark"]).toBe(2);
  // both cursors advanced over the SHARED offset sequence (ephemeral offsets included)
  expect(tally.offset).toBeGreaterThanOrEqual(chunky.offset);
  expect(chunky.offset).toBeGreaterThanOrEqual(5);

  // 4. ephemeral misuse is a loud error
  let bad = "";
  try {
    await itx.invokeCapability(`itx.append({ type: 'x', ephemeral: true, idempotencyKey: 'k' })`);
  } catch (e) {
    bad = String(e);
  }
  // ephemeral+idempotencyKey rejected
  expect(bad).toMatch(/idempotencyKey/);
});
