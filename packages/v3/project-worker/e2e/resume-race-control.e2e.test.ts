// resume-race-control.e2e.test.ts — CONTROL for prove_resume_race: the SAME gated-target failure,
// but WITHOUT a resume racing it. A plain forwarder delivery failure must schedule the retry ladder
// (~1s backoff) and re-deliver within a couple seconds. If this recovers fast but resume-race stalls,
// the resume's rev-bump (suppressing #onDeliveryFailure's retry scheduling) is the proven culprit.
// (was proofs/prove_resume_race_control.mjs)

import { expect, test } from "vitest";
import { freshCtx, openItx, sleep } from "./support/client.ts";

test("plain forwarder delivery failure retries via the ladder (no resume in play)", async () => {
  const itx = openItx(freshCtx("ctl"));
  const keep: unknown[] = [];

  let invocations = 0;
  const fn = async (events: { offset: number }[]) => {
    invocations++;
    if (invocations === 1) throw new Error("target down (first delivery), no resume in play");
    return { ok: true, offs: events.map((e) => e.offset) };
  };

  const key = crypto.randomUUID();
  keep.push(await itx.rpcStubs.provide(fn, { key }));
  await itx.provide({ path: "itx.ctlHook", target: `itx.rpcStubs.get('${key}')` });
  await itx.subscribe({
    name: "ctl",
    target: "itx.ctlHook",
    consumes: ["mark"],
    start: "beginning",
  });

  await itx.invokeCapability(`itx.stream.append({"type":"mark"})`);
  const t0 = Date.now();
  while (Date.now() - t0 < 15000 && invocations < 2) await sleep(200);
  // plain failure retried within 15s (retry ladder works)
  expect(invocations).toBeGreaterThanOrEqual(2);
});
