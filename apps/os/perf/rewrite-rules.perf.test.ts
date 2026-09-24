// perf/rewrite-rules.perf.test.ts — THE REWRITE-TABLE BUDGET: with 300 rules in a context, invoking
// the NEWEST rule and a built-in root each stay under 150 ms (the median of 12 round trips), so a
// dispatch never walks the table. rewrite-rules.e2e proves the newest rule still rewrites; this
// measures it alone (vitest.config.ts `perf`), where a round trip is the platform's and not the
// e2e suite's contention.

import { expect, test } from "vitest";
import { freshCtx, openItx } from "../e2e/support/client.ts";

test("300 rules: invoking the NEWEST rule and a built-in root both stay under 150ms", async () => {
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

  const newestMs = await medianMs(() => itx.invoke(["itx", ["m299"]]));
  const rootMs = await medianMs(() => itx.invoke(["itx", ["whoami"]]));
  console.log(
    `[300 rules] newest-rule median ${newestMs.toFixed(1)}ms, built-in root median ${rootMs.toFixed(1)}ms`,
  );
  expect(newestMs, `newest rule (m299) median ${newestMs.toFixed(1)}ms`).toBeLessThan(150);
  expect(rootMs, `built-in root (whoami) median ${rootMs.toFixed(1)}ms`).toBeLessThan(150);
}, 90_000);

/** The median of `iterations` sequential round trips of `call`, in ms. */
async function medianMs(call: () => Promise<unknown>, iterations = 12): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await call();
    samples.push(performance.now() - t0);
  }
  return samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
}
