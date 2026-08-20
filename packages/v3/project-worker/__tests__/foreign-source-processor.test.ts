// __tests__/foreign-source-processor.test.ts — A PROCESSOR THAT REDUCES A FOREIGN STREAM.
//
// The off-platform requirement, at its core: a noisy stream lives ELSEWHERE (a Raspberry-Pi box, or
// just another context), and a stream processor running in a CF Durable Object reduces it — keeping
// only the small derived state, never the raw firehose. This is the "processors live in a different
// DO at the edge" shape Jonas asked for.
//
// The mechanism (zero new transport): a processor already takes its source as an injected
// `ProcessorStream` (core/processor.ts). Enabling it with `sourceStream` (a sturdy-ref itx-expression
// naming a FOREIGN stream) makes the facet read/append that stream by RESTORING the ref through the
// parent's `invoke` — `contexts.get('/x').read(...)`, the cross-DO read that already exists. Because
// the events don't come from THIS DO's log, the commit pump skips a foreign-source facet; it catches
// up from the foreign stream on snapshot instead.
//
// Here the "foreign box" is a SIBLING context (`itx.contexts.get('/sensors')`) — the same
// `contexts.get` addressing an off-platform Pi would use. We append sensor events to the sibling,
// enable a `tally` processor on the ROOT context pointed at the sibling, and prove the tally counts
// the SIBLING's events while the root's OWN log stays empty.
//
// Run: pnpm exec vitest run --project harness __tests__/foreign-source-processor.test.ts

import { afterAll, beforeAll, expect, test } from "vitest";
import { startProjectHarness, type ProjectHarness } from "./harness.ts";

let harness: ProjectHarness;
beforeAll(async () => {
  harness = await startProjectHarness();
}, 120_000);
afterAll(async () => {
  await harness?.stop();
});

async function until<T>(
  label: string,
  fn: () => Promise<T | undefined | false>,
  ms = 10_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v !== undefined && v !== false) return v as T;
      last = v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`until(${label}): ${JSON.stringify(last)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("a processor reduces a FOREIGN stream (a sibling context), keeping derived state off its own log", async () => {
  const ctx = `prj_fsrc_${Date.now().toString(36)}`;
  const itx = await harness.itx(ctx);

  // 1. The FOREIGN stream: a sibling context `/sensors`. Append sensor events to IT (never to the
  //    root's own log). `itx.invoke` takes a structured expression — no string interpolation.
  const appendToSensors = (event: Record<string, unknown>) =>
    itx.invoke(["itx", "contexts", ["get", "/sensors"], ["append", event]]);
  await appendToSensors({ type: "motion", payload: { room: "kitchen" } });
  await appendToSensors({ type: "motion", payload: { room: "hall" } });
  await appendToSensors({ type: "temp", payload: { c: 21 } });

  // 2. Enable a `tally` processor on the ROOT, pointed at the foreign `/sensors` stream. The tally
  //    counts events by type — it should count the SIBLING's events, not the root's.
  await itx.enableProcessor("tally", undefined, {
    sourceStream: "itx.contexts.get('/sensors')",
  });

  // 3. The tally's snapshot catches up from the foreign stream (the pump doesn't drive it). Poll
  //    until it reflects the sibling's three events.
  const counts = await until("tally reduced the foreign /sensors events", async () => {
    const snap = (await itx.facetSnapshot("tally")) as {
      state: { counts: Record<string, number> };
    };
    const c = snap?.state?.counts ?? {};
    return c.motion === 2 && c.temp === 1 ? c : false;
  });
  expect(counts).toEqual({ motion: 2, temp: 1 }); // reduced the FOREIGN stream

  // 4. THE POINT: the foreign events never touched the ROOT's own log — the root holds only the
  //    derived tally, not the firehose. (The root's own stream is empty of sensor events.)
  const rootPage = (await itx.invokeCapability({ path: ["stream", "read"], args: [] })) as {
    events: Array<{ type: string }>;
  };
  expect(rootPage.events.some((e) => e.type === "motion" || e.type === "temp")).toBe(false);
});
