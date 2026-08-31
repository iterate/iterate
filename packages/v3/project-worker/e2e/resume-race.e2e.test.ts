// resume-race.e2e.test.ts — ADVERSARIAL: a resumeSubscription that lands WHILE a forwarder delivery
// is in flight, where that in-flight delivery then FAILS.
//
// The forwarder's #pumpRow holds a per-row in-flight guard. When subscription-resumed arrives,
// #reset bumps `rev` and calls #pumpRow — which BAILS on the in-flight guard. The in-flight
// delivery then rejects, so #onDeliveryFailure runs, sees `fresh.rev !== progress.rev` (the reset
// bumped it) and RETURNS WITHOUT scheduling a retry or a halt. Nothing re-triggers the pump.
//
// EXPECTED (correct): after the operator's resume, the subscription re-delivers promptly (the
//   reset asked for exactly that). A healthy forwarder delivers within ~1-2s.
// SUSPECTED BUG: the row STALLS (no delivery) until the parent's next +60s idle alarm happens to
//   pump the forwarder — a stuck subscription with no error, no halt, no audit fact.
//
// A gated callback (parked as an ABSENT target → the forwarder lane) lets us hold delivery #1 in
// flight, land the resume, then reject delivery #1. Then we measure the stall.
// (was proofs/prove_resume_race.mjs)

import { expect, test } from "vitest";
import { freshCtx, openItx, sleep, until } from "./support/client.ts";

// Was RED when authored (the resume's rev-bump suppressed #onDeliveryFailure's retry scheduling,
// stalling the row until the ~60s idle alarm); the bug is FIXED — this is now the regression pin.
test("resume racing an in-flight forwarder delivery that then fails must re-deliver promptly (no stall)", async () => {
  const itx = openItx(freshCtx("race"));
  const keep: unknown[] = [];

  // ── the gated forwarder target: delivery #1 is held then REJECTED; later deliveries record + ok ──
  let invocations = 0;
  const seen: { inv: number; offs: number[] }[] = []; // { inv, offs } per callback invocation
  let releaseGate!: () => void; // resolves the held first delivery
  const gate = new Promise<void>((r) => (releaseGate = r));
  const fn = async (events: { offset: number }[]) => {
    invocations++;
    const inv = invocations;
    const offs = (events ?? []).map((e) => e.offset);
    seen.push({ inv, offs });
    if (inv === 1) {
      await gate; // hold delivery #1 in flight so the resume can race it
      throw new Error("target down (simulated failure AFTER the resume landed)");
    }
    return { ok: true };
  };

  // mountHook: park the live callback, alias it at itx.raceHook — an ABSENT target from the
  // subscription lane's view, so the subscription rides the subscription-forwarder facet.
  const key = crypto.randomUUID();
  keep.push(await itx.rpcStubs.provide(fn, { key }));
  await itx.provide({ path: "itx.raceHook", target: `itx.rpcStubs.get('${key}')` });

  // subscribe (durable/forwarder lane). start:beginning so the reset target (offset 0) is meaningful.
  const sub = await itx.subscribe({
    name: "race",
    target: "itx.raceHook",
    consumes: ["mark"],
    start: "beginning",
  });
  expect(sub.name).toBeTruthy(); // subscribed on the forwarder lane

  const append = (ev: unknown) => itx.invokeCapability(`itx.stream.append(${JSON.stringify(ev)})`);

  // 1. m1 → the forwarder delivers [m1]; the callback holds it in flight.
  const [m1] = await append({ type: "mark", payload: { n: 1 } });
  await until("delivery #1 in flight", () => invocations >= 1);
  expect(invocations).toBe(1); // delivery #1 is held in flight

  // 2. m2 commits while #1 is in flight (its own pump attempt bails on the in-flight guard).
  const [m2] = await append({ type: "mark", payload: { n: 2 } });

  // 3. the operator resumes DURING the in-flight delivery — reset to before m1 (bumps rev).
  await itx.resumeSubscription({ name: "race", afterOffset: 0 });

  // 4. release delivery #1 → it REJECTS → #onDeliveryFailure sees the bumped rev → returns, no retry.
  releaseGate();

  // 5. STALL WINDOW: a healthy forwarder re-delivers within ~1-2s. Watch for delivery #2 for 8s.
  const STALL_WINDOW_MS = 8000;
  let recoveredWithin = false;
  {
    const t0 = Date.now();
    while (Date.now() - t0 < STALL_WINDOW_MS) {
      if (invocations >= 2) {
        recoveredWithin = true;
        break;
      }
      await sleep(200);
    }
  }
  // THE REGRESSION PIN: the rev-CAS-continue fix means the failed delivery reschedules promptly —
  // a stall here is the stuck-subscription bug come back. (The original RED proof had a second
  // 75s wait for the ~60s idle alarm to distinguish stall from permanent loss; with prompt
  // recovery asserted fatally above, that branch is unreachable and is not ported.)
  expect(recoveredWithin).toBe(true);

  // no data loss: m1 and m2 are both (re)delivered after the recovery
  const laterOffsets = seen.slice(1).flatMap((s) => s.offs);
  expect(laterOffsets).toContain(m1.offset);
  expect(laterOffsets).toContain(m2.offset);

  // host-state sanity: the row is on the durable lane and the forwarder facet is enabled.
  const state = await itx.hostState();
  const row = state.subscriptionMounts?.find((r: { name: string }) => r.name === "race");
  expect(row?.lane).toBe("durable");
  expect(state.facetProcessors).toContain("subscription-forwarder");
});
