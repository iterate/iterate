// stream-wake-loop.e2e.test.ts — THE SELF-WAKE BILLING CONTROL (wave-0 3b, Jonas: "we need runaway
// billing controls"). The control (stream.ts SELF_WAKE_HALT_STREAK) is proven deterministically in
// src/stream/stream-self-wake.test.ts (halts at N, resumes on a public door, durable across
// incarnations); its DO wiring is live. This file is the DEPLOYED, EVICTION-RATE-DEPENDENT observation.
//
// MEASURED (2026-09-07, deployed): the self-wake loop the plan feared as "one billed wake per minute
// forever" is a SLOW DRIP, not a runaway. The streak only advances on an EVICTED, no-public-door
// incarnation (the incarnation that handled a request holds #publicDoorTouched for its whole life),
// and evictions are Cloudflare-timed: a cursor-sub-on-`stream/woken` drips ~+2 `woken` / 8 min; a
// stuck-retry cursor got 3 in 90 s. So reaching N takes minutes and varies run to run — a
// time-bounded pin would flake the board. Hence: OPT-IN via RUN_WAKE_LOOP_PROBE, like the degradation
// probes, so it never runs in the sequential board; run it by hand and record `streak reached k`.
//
//   RUN_WAKE_LOOP_PROBE=1 WORKER_BASE_URL=https://project-worker.iterate.workers.dev \
//     npx vitest run --config e2e/vitest.config.ts stream-wake-loop

import { expect, test } from "vitest";
import { append, disposeSessions, freshCtx, openItx, readAll, sleep } from "./support/client.ts";

const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)\b/.test(process.env.WORKER_BASE_URL ?? "");
const OPT_IN = process.env.RUN_WAKE_LOOP_PROBE === "1";
const probe = test.skipIf(LOCAL || !OPT_IN);
const WOKEN = "events.iterate.com/stream/woken";
const HALTED = "events.iterate.com/stream/self-wake-halted";

/** A cursor target that ALWAYS throws a plain (retryable) error — the stuck delivery whose retry
 *  ladder self-wakes fastest (the stream keeps its cursor; an entrypoint cannot own progress). */
const THROWING_WORKER = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Thrower extends WorkerEntrypoint {
  async processEventBatch(events, range) { throw new Error("wake-loop: this delivery always fails (retryable)"); }
}`,
};

const IDLE_MS = 11 * 60_000; // long enough for several evicted no-door self-wakes to accrue toward N

probe(
  "OBSERVE (opt-in): a stuck cursor delivery on a dormant context self-wakes; the circuit-breaker halts it — records streak reached",
  { timeout: IDLE_MS + 120_000 },
  async () => {
    const ctx = freshCtx("wake-loop");
    const itx = openItx(ctx);
    await itx.provide("itx.faildeliver", ["itx", "workers", ["get", { source: THROWING_WORKER }]]);
    await itx.subscribe({
      name: "faildeliver",
      target: "itx.faildeliver.processEventBatch",
      consumes: ["kick"],
    });
    await append(itx, { type: "kick", payload: { n: 1 } }); // kicks the ladder
    disposeSessions(); // disconnect — the ladder runs off the DO's own alarm, untouched
    await sleep(IDLE_MS);

    const events = await readAll(openItx(ctx)); // one read at the end (the halt, if any, already happened)
    const selfWakeHalts = events.filter((e) => e.type === HALTED).length;
    const woken = events.filter((e) => e.type === WOKEN).length;
    const streakReached = Number((events.find((e) => e.type === HALTED)?.payload as { streak?: number } | undefined)?.streak ?? 0);
    console.log(
      `wake-loop OBSERVE: over ${IDLE_MS / 60000}min — woken=${woken}, self-wake-halted=${selfWakeHalts}, streak reached=${streakReached || "<N (drip too slow this run)"}`,
    );
    // The context is never poisoned by the loop or the halt; the durable log survives.
    const [ev] = await append(openItx(ctx), { type: "after-observe" });
    expect(ev.offset).toBeGreaterThan(0);
    // If the drip reached N this run, the halt was recorded exactly once — the control fired.
    if (selfWakeHalts > 0) expect(selfWakeHalts).toBe(1);
  },
);
