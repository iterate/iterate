// resub-zombie.e2e.test.ts — THE RE-SUBSCRIBE / UNSUBSCRIBE ZOMBIE PIN. Was RED on live-31: a
// re-subscribe under the same name left the FIRST callback's parked stub online, and unsubscribe
// popped only the newest mount, restoring the shadowed older one — delivery kept flowing to a
// callback the client could no longer see or address (delivery-after-unsubscribe + a stale table).
//
// WHAT THE PIN GUARDS NOW, under "the mount is data, the stub is physical":
//   1. Re-subscribing the SAME name re-parks under the same registry key (`itx.subscribers.s`):
//      the session's Parking disposes the first relay (its pager closes, the DO drops that
//      transport — "replaced"), so the first callback is physically unreachable. The provide door
//      is IDEMPOTENT for an unchanged policy, so the table keeps ONE row at the path — there is
//      no shadowed older mount to resurrect.
//   2. unsubscribe(name) clears EVERY row at the path (`all: true`) AND closes this session's
//      stub under it — no mount is re-elected, no callback stays reachable.
// (was proofs/probe_resub_zombie.mjs)

import { expect, test } from "vitest";
import { freshCtx, bareItx, sleep, subscriberMounts } from "./support/client.ts";

const rowsAt = async (itx: any, path: string): Promise<unknown[]> =>
  (await itx.invokeCapability("itx.facets.get('capability-table').snapshot()")).state.mounts.filter(
    (m: { path: string[] }) => m.path.join(".") === path,
  );

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
  await itx.invokeCapability("itx.append({ type: 'ctl', payload: { n: 1 } })");
  await sleep(2000);
  expect(ctrl).toBe(1); // control: single subscribe delivers
  await itx.unsubscribe({ name: "control" });
  await sleep(800);
  await itx.invokeCapability("itx.append({ type: 'ctl', payload: { n: 2 } })");
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

  // the door was idempotent: the re-subscribe (same target, same policy) appended NO second row
  expect(await rowsAt(itx, "itx.subscribers.s")).toHaveLength(1);

  await itx.invokeCapability("itx.append({ type: 'mark', payload: { n: 1 } })");
  await sleep(2500);
  // while both subscribed: only newest (cb2) delivered — cb1's transport was replaced
  expect(cb2).toBe(1);
  expect(cb1).toBe(0);

  await itx.unsubscribe({ name: "s" }); // client expects: subscription 's' fully gone
  await sleep(1000);
  await itx.invokeCapability("itx.append({ type: 'mark', payload: { n: 2 } })");
  await sleep(3000);

  // THE CONTRACT the bug violated: after unsubscribe('s'), no callback under 's' receives anything.
  // The FIRST callback receives NOTHING (no zombie delivery to the shadowed mount)…
  expect(cb1).toBe(0);
  expect(cb1seqs).not.toContain(2);
  // …and the capability table shows NO subscription named 's'
  expect((await subscriberMounts(itx)).some((r: { name: string }) => r.name === "s")).toBeFalsy();
});
