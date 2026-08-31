// resub-zombie.e2e.test.ts — ADVERSARIAL PROOF (RED on live-31): re-subscribe same name +
// unsubscribe resurrects a ZOMBIE subscription that keeps delivering to the FIRST callback.
//
// ROOT CAUSE (two cooperating defects):
//   1. itx.subscribe() ALWAYS mints a fresh relay+key and calls Parking.addNamed(name, relay)
//      (core/itx-surface.ts:108-111 + :416). addNamed OVERWRITES #named[name] but leaves the
//      previous relay in #relays, NEVER disposed — so the first callback's parked stub stays ONLINE.
//   2. unsubscribe(name) revokes BY PATH (core/itx-surface.ts:431); revokeCapability-by-path pops
//      only the NEWEST winner and RESTORES the shadowed older mount
//      (stream-durable-object.ts:1008-1012). disposeNamed(name) disposes only the relay in #named
//      (the newest). So after unsubscribe: the OLD mount M1 becomes the winner again, its target key
//      is still online (defect 1) → the commit pump resumes delivery to the FIRST callback.
//
// The client both REPLACED (re-subscribe same name) and UNSUBSCRIBED that name, yet delivery
// continues to a callback it can no longer see or address. Delivery-after-unsubscribe + stale host state.
// (was proofs/probe_resub_zombie.mjs)

import { expect, test } from "vitest";
import { freshCtx, bareItx, sleep } from "./support/client.ts";

// Was RED when authored (re-subscribe left the first relay online and unsubscribe-by-path restored
// the shadowed older mount → zombie delivery to cb1). FIXED — this is now the regression pin.
test("re-subscribe + unsubscribe on the same name must not leave a zombie delivering to the first callback", async () => {
  const itx = bareItx(freshCtx("zomb"));

  // ── CONTROL: a SINGLE subscribe then unsubscribe must stop delivery (unsubscribe works normally) ──
  let ctrl = 0;
  await itx.subscribe({
    name: "control",
    consumes: ["ctl"],
    target: (events: unknown[]) => (ctrl += events.length),
  });
  await itx.invokeCapability("itx.stream.append({ type: 'ctl', payload: { n: 1 } })");
  await sleep(2000);
  expect(ctrl).toBe(1); // control: single subscribe delivers
  await itx.unsubscribe({ name: "control" });
  await sleep(800);
  await itx.invokeCapability("itx.stream.append({ type: 'ctl', payload: { n: 2 } })");
  await sleep(2500);
  // control: NO delivery after unsubscribe (unsubscribe works for a single sub)
  expect(ctrl).toBe(1);

  // ── BUG: re-subscribe the SAME name, then unsubscribe once ──
  let cb1 = 0;
  let cb2 = 0;
  const cb1seqs: unknown[] = [];
  await itx.subscribe({
    name: "s",
    consumes: ["mark"],
    target: (events: { payload?: { n?: unknown } }[]) =>
      events.forEach((e) => {
        cb1++;
        cb1seqs.push(e.payload?.n);
      }),
  });
  await itx.subscribe({
    name: "s", // re-subscribe SAME name — the client's model: this replaces cb1
    consumes: ["mark"],
    target: (events: unknown[]) => (cb2 += events.length),
  });

  await itx.invokeCapability("itx.stream.append({ type: 'mark', payload: { n: 1 } })");
  await sleep(2500);
  // while both subscribed: only newest (cb2) delivered
  expect(cb2).toBe(1);
  expect(cb1).toBe(0);

  await itx.unsubscribe({ name: "s" }); // client expects: subscription 's' fully gone
  await sleep(1000);
  await itx.invokeCapability("itx.stream.append({ type: 'mark', payload: { n: 2 } })");
  await sleep(3000);

  const st = await itx.hostState();

  // THE CONTRACT the bug violated: after unsubscribe('s'), no callback under 's' receives anything.
  // The FIRST callback receives NOTHING (no zombie delivery to the shadowed mount)…
  expect(cb1).toBe(0);
  expect(cb1seqs).not.toContain(2);
  // …and host state shows NO subscription named 's'
  expect(st.subscriptionMounts?.some((r: { name: string }) => r.name === "s")).toBeFalsy();
});
