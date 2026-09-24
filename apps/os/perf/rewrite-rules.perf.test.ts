// perf/rewrite-rules.perf.test.ts — THE REWRITE-TABLE BUDGET: with 300 rules in a context, invoking
// the NEWEST rule and a built-in root each stay under 150 ms (the median of 12 round trips, perf/latency.ts
// `rules.300.*`), so a dispatch never walks the table. rewrite-rules.e2e proves the newest rule still
// rewrites; this measures it alone (vitest.config.ts `perf`), where a round trip is the platform's and
// not the e2e suite's contention.

import { expect, test } from "vitest";
import { freshCtx, openItx } from "../e2e/support/client.ts";
import { recordLatency } from "./record.ts";

test("300 rules: invoking the NEWEST rule and a built-in root both stay under 150ms", async ({
  task,
}) => {
  const ctx = freshCtx("rules300");
  const itx = openItx(ctx);
  const rules = Array.from({ length: 300 }, (_, i) => ({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: `itx.m${i}`, target: ["itx", "whoami"] },
  }));
  expect(await itx.append(...rules)).toHaveLength(300);

  // Warm both lanes once (table rehydration / DO wake are not what we are measuring).
  expect(await itx.invoke(["itx", ["m299"]])).toMatchObject({ projectId: ctx, path: "/" });
  await itx.invoke(["itx", ["whoami"]]);

  recordLatency(task, "rules.300.newest", await roundTrips(() => itx.invoke(["itx", ["m299"]])));
  recordLatency(task, "rules.300.root", await roundTrips(() => itx.invoke(["itx", ["whoami"]])));
}, 90_000);

/** `iterations` sequential round trips of `call`, in ms each. */
async function roundTrips(call: () => Promise<unknown>, iterations = 12): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await call();
    samples.push(performance.now() - t0);
  }
  return samples;
}
