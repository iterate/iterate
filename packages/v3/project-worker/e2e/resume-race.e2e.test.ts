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
//
// The SECOND test is the other half of the same rev-CAS: the in-flight delivery SUCCEEDS after the
// reset lands. The success write must LOSE (never advance the cursor past the reset) and the batch
// redelivers from the reset cursor.

import { expect, test } from "vitest";
import { freshCtx, openItx, sleep, until } from "./support/client.ts";

// Was RED when authored (the resume's rev-bump suppressed #onDeliveryFailure's retry scheduling,
// stalling the row until the ~60s idle alarm); the bug is FIXED — this is now the regression pin.
test("resume racing an in-flight forwarder delivery that then fails must re-deliver promptly (no stall)", async () => {
  const itx = openItx(freshCtx("race"));

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

  // mountHook: park the live callback AT itx.raceHook (the mount path IS its identity). The
  // subscription's target is the EXPRESSION "itx.raceHook" — an ABSENT target from the
  // subscription lane's view, so the subscription rides the subscription-forwarder facet.
  await itx.provide("itx.raceHook", fn);

  // subscribe (durable/forwarder lane). start:beginning so the reset target (offset 0) is meaningful.
  const sub = await itx.subscribe({
    name: "race",
    target: "itx.raceHook",
    consumes: ["mark"],
    start: "beginning",
  });
  expect(sub.name).toBeTruthy(); // subscribed on the forwarder lane

  const append = (ev: unknown) => itx.invokeCapability(`itx.append(${JSON.stringify(ev)})`);

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

// The SUCCESS variant of the reset CAS (was __tests__/failing-delivery.test.ts's "forwarder reset
// CAS" todo): same rig, but delivery #1 returns ok AFTER the resume landed. #pumpRow's success path
// re-reads progress and compares `rev` before writing — the reset bumped it, so the in-flight
// success write is DISCARDED (`continue`), and the loop re-pumps from the reset cursor.
test("resume racing an in-flight forwarder delivery that then SUCCEEDS: the reset wins — the success write must not advance the cursor, m1 redelivers", async () => {
  const itx = openItx(freshCtx("racewin"));

  // ── the gated forwarder target: delivery #1 is held then returns OK; every delivery records ──
  let invocations = 0;
  const seen: { inv: number; offs: number[] }[] = []; // { inv, offs } per callback invocation
  let releaseGate!: () => void; // resolves the held first delivery
  const gate = new Promise<void>((r) => (releaseGate = r));
  const fn = async (events: { offset: number }[]) => {
    invocations++;
    const inv = invocations;
    const offs = (events ?? []).map((e) => e.offset);
    seen.push({ inv, offs });
    if (inv === 1) await gate; // hold delivery #1 in flight so the resume can race it
    return { ok: true }; // SUCCESS — the write that must lose the CAS to the reset
  };

  // mountHook: park the live callback AT itx.raceHook (the mount path IS its identity). The
  // subscription's target is the EXPRESSION "itx.raceHook" — an ABSENT target from the
  // subscription lane's view, so the subscription rides the subscription-forwarder facet.
  await itx.provide("itx.raceHook", fn);

  // subscribe (durable/forwarder lane). start:beginning so the reset target (offset 0) is meaningful.
  const sub = await itx.subscribe({
    name: "racewin",
    target: "itx.raceHook",
    consumes: ["mark"],
    start: "beginning",
  });
  expect(sub.name).toBeTruthy(); // subscribed on the forwarder lane

  const append = (ev: unknown) => itx.invokeCapability(`itx.append(${JSON.stringify(ev)})`);

  // 1. m1 → the forwarder delivers [m1]; the callback holds it in flight.
  const [m1] = await append({ type: "mark", payload: { n: 1 } });
  await until("delivery #1 in flight", () => invocations >= 1);
  expect(invocations).toBe(1); // delivery #1 is held in flight
  expect(seen[0].offs).toEqual([m1.offset]); // and it carried exactly [m1]

  // 2. the operator resumes DURING the in-flight delivery — reset to before m1 (bumps rev, parks
  //    the cursor at 0; the reset's own pump bails on the in-flight guard).
  await itx.resumeSubscription({ name: "racewin", afterOffset: 0 });
  // Let the subscription-resumed fact drive through to the forwarder's #reset before releasing.
  // (Best-effort ordering only — if the release ever wins this race the reset lands after the
  // success write and STILL redelivers m1, so the contract below holds either way.)
  await sleep(600);

  // 3. release delivery #1 → it returns ok → the success write hits the rev CAS and must LOSE.
  releaseGate();

  // THE CONTRACT: the reset wins. The in-flight success must not advance the cursor past the
  // reset, so m1 REDELIVERS from the reset cursor — its offset shows up in a LATER invocation.
  await until("m1 redelivered after the reset", () =>
    seen.slice(1).some((s) => s.offs.includes(m1.offset)),
  );

  // liveness after the race: the row keeps delivering — the discarded write didn't wedge the cursor.
  const [m2] = await append({ type: "mark", payload: { n: 2 } });
  await until("m2 delivered after recovery", () => seen.flatMap((s) => s.offs).includes(m2.offset));

  // host-state sanity: the row is on the durable lane and the forwarder facet is enabled.
  const state = await itx.hostState();
  const row = state.subscriptionMounts?.find((r: { name: string }) => r.name === "racewin");
  expect(row?.lane).toBe("durable");
  expect(state.facetProcessors).toContain("subscription-forwarder");
});
