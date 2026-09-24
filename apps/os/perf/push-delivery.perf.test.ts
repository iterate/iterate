// perf/push-delivery.perf.test.ts — THE PUSH-DELIVERY BUDGETS: how fast the loads push-delivery.e2e
// proves correct (e2e/support/push-load.ts) run, measured with nothing else on the wire. The perf
// project runs its files one at a time and their rows in order (vitest.config.ts), and the soak runs
// it after each e2e run, never beside one (scripts/e2e-soak.ts). These budgets used to sit in the
// e2e rows, where 16 files ran at once against one worker and a latency measured the suite's
// contention as much as the platform: a 1.6 s whoami against 1.5 s (main f5fdb3cf) and a 582 ms p50
// against 500 (#2962), each green on its retry, in 2 of 124 e2e jobs.
//
// Every scenario runs ROUNDS times and its budget holds for the MEDIAN round: a regression moves
// every round, one platform stall moves one (a whole round 10× slower than the next, seen on
// 2026-09-24). Every round's numbers are printed and recorded (perf/record.ts), and the scheduled
// latency guard judges them too. The budgets are the e2e rows' old ones (perf/latency.ts `push.*`).

import { expect, test } from "vitest";
import { freshCtx, openItx } from "../e2e/support/client.ts";
import { ephemeralFlood, fanProbes, pushSubscribers } from "../e2e/support/push-load.ts";
import { recordLatency } from "./record.ts";

const ROUNDS = 5;

test("ephemeral flood: p50 latency under 500 ms, p95 under 1.5 s, over 1000 events/s end to end", async ({
  task,
}) => {
  const floods = [];
  for (let round = 1; round <= ROUNDS; round++) {
    // a fresh context each round, so no round inherits the last one's subscriber or log
    const flood = await ephemeralFlood(openItx(freshCtx(`flood${round}`)));
    console.log(`[round ${round}] ${flood.line}`);
    expect(flood.seqs).toHaveLength(flood.total);
    floods.push(flood);
  }
  recordLatency(
    task,
    "push.flood.p50",
    floods.map((f) => f.latencyMs.p50),
  );
  recordLatency(
    task,
    "push.flood.p95",
    floods.map((f) => f.latencyMs.p95),
  );
  recordLatency(
    task,
    "push.flood.throughput",
    floods.map((f) => f.endToEndEventsPerSecond),
  );
}, 120_000);

test("200 push subscribers: one append reaches all 200 in under 2 s, and a whoami during it takes under 1.5 s", async ({
  task,
}) => {
  const itx = openItx(freshCtx("fan200"));
  const fan = await pushSubscribers(itx, 200);
  const wallMs: number[] = [];
  const whoamiMs: number[] = [];
  for (let round = 2; round < 2 + ROUNDS; round++) {
    const t0 = performance.now();
    await fan.ping(round);
    // an UNRELATED call during the fan-out: 200 pushes never head-of-line-block the stream
    whoamiMs.push(await timed(() => itx.whoami()));
    await fan.delivered(round);
    wallMs.push(performance.now() - t0);
    console.log(
      `[round ${round}] 200 subscribers in ${wallMs.at(-1)!.toFixed(0)}ms, whoami ${whoamiMs.at(-1)!.toFixed(0)}ms`,
    );
  }
  expect(fan.counts.every((c) => c === 1 + ROUNDS)).toBe(true);
  recordLatency(task, "push.fan200.all", wallMs);
  recordLatency(task, "push.fan200.whoami", whoamiMs);
}, 180_000);

test("50 userspace processors: one append reaches all 50 in under 5 s, and a whoami during it takes under 1.5 s", async ({
  task,
}) => {
  const itx = openItx(freshCtx("fan50"));
  const probes = await fanProbes(itx, 50);
  const wallMs: number[] = [];
  const whoamiMs: number[] = [];
  for (let round = 1; round <= ROUNDS; round++) {
    const t0 = performance.now();
    const offset = await probes.mark();
    // an UNRELATED call during the fan-out: 50 facet pushes never head-of-line-block the stream
    whoamiMs.push(await timed(() => itx.invoke(["itx", ["whoami"]])));
    await probes.reached(offset);
    wallMs.push(performance.now() - t0);
    console.log(
      `[round ${round}] 50 processors reached offset ${offset} in ${wallMs.at(-1)!.toFixed(0)}ms, whoami ${whoamiMs.at(-1)!.toFixed(0)}ms`,
    );
  }
  recordLatency(task, "push.fan50.all", wallMs);
  recordLatency(task, "push.fan50.whoami", whoamiMs);
}, 240_000);

/** `ms` of `call`, started now. */
async function timed(call: () => Promise<unknown>): Promise<number> {
  const t0 = performance.now();
  await call();
  return performance.now() - t0;
}
