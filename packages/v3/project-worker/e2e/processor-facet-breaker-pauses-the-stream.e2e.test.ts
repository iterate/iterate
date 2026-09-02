// processor-facet-breaker-pauses-the-stream.e2e.test.ts — POLICY IS A FACET PROCESSOR that speaks
// core's control events. The token-bucket breaker (e2e/support/sources.ts `src/breaker.js`) is an
// ordinary two-class userspace source: a pure `BreakerProcessor` whose reduce spends one token per
// durable non-control event (refilling from the EVENT's createdAt — pure, replayable) and whose
// processEvent trips exactly on the crossing (tokens ≥ 0 → < 0) by appending
// events.iterate.com/stream/paused with its reason. Core knows nothing about breakers: the pause
// check in Stream.append reads the reduced `paused` slice, whoever appended it. Proves: enabling
// the processor + a burst past the capacity → the `paused` event lands with the breaker's reason
// and provenance, a further append refuses with STREAM_PAUSED, and an operator's plain
// stream/resumed restores flow.

import { expect, test } from "vitest";
import { append, codeOf, freshCtx, openItx, readAll, rejection } from "./support/client.ts";
import { enableFixtureProcessor } from "./support/sources.ts";

const PAUSED = "events.iterate.com/stream/paused";

test("a burst past the breaker's capacity pauses the stream (the facet appends `paused` with its reason); appends refuse with STREAM_PAUSED; an operator's `resumed` restores flow", async () => {
  const itx = openItx(freshCtx("breaker"));
  // enableProcessor("breaker", { source: "itx.kv.get('src/breaker.js')", className: "BreakerDurableObject" })
  await enableFixtureProcessor(itx, "breaker");
  // The breaker's own enablement (subscription-configured) is a durable non-control event: the bucket
  // (capacity 5) is at 4 once it has folded its own row. Nothing paused yet.
  await append(itx, { type: "warm" }); // 3 left
  expect((await readAll(itx)).some((e) => e.type === PAUSED)).toBe(false);

  // ONE batch of 8 durable events — more than the bucket holds. The crossing happens mid-batch; the
  // breaker's processEvent trips exactly once (the crossing), appending `paused`.
  const burst = await append(
    itx,
    ...Array.from({ length: 8 }, (_, i) => ({ type: "burst", payload: { i } })),
  );
  expect(burst).toHaveLength(8); // the burst itself was admitted — policy reads the FOLD, after the commit
  const paused = await itx.waitForEvent({ type: PAUSED, afterOffset: 0, timeoutMs: 20_000 });
  expect(paused.payload).toEqual({ reason: "breaker: durable events exceeded the bucket" });
  // provenance: the engine stamps every processor emit with its slug — the log says WHO paused it
  expect(paused.source?.processor).toMatchObject({ slug: "breaker", version: "1.0.0" });
  expect(paused.source?.processor?.whileProcessing?.type).toBe("burst");
  expect(paused.idempotencyKey).toMatch(/^breaker\/trip@\d+$/); // a replay can never double-pause

  // the stream is paused: a further append refuses at the door, coded, with the breaker's reason
  const err = await rejection(append(itx, { type: "more" }));
  expect(codeOf(err)).toBe("STREAM_PAUSED");
  expect(err.message).toContain("stream paused: breaker: durable events exceeded the bucket");
  // the core snapshot shows the same truth
  const core = await itx.invokeCapability("itx.facets.get('core').snapshot()");
  expect(core.state.paused).toEqual({ reason: "breaker: durable events exceeded the bucket" });

  // the operator's recovery is a plain control append — resume always lands on a paused stream
  await append(itx, { type: "events.iterate.com/stream/resumed" });
  const [after] = await append(itx, { type: "after" });
  expect(after.offset).toBeGreaterThan(paused.offset); // flow restored
  // the bucket is in debt (no second crossing) — the ONE trip is the only `paused` in the log
  expect((await readAll(itx)).filter((e) => e.type === PAUSED)).toHaveLength(1);
  // and the breaker's reduced state is the pure fold of the log: tokens below zero, replayable
  const snap = await itx.invokeCapability("itx.facets.get('breaker').snapshot()");
  expect(snap.state.tokens).toBeLessThan(0);
  expect(snap.state.lastAtMs).toBeGreaterThan(0);
});
