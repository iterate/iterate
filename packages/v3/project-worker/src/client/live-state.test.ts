// client/live-state.test.ts — the client half's transport pins (the store's own reduce is exercised through it).

import { expect, test } from "vitest";
import { connectLiveState, type LiveStateDelta, type LiveStateSeed } from "./live-state.ts";

// ── live state client ── `connectLiveState` (client/live-state.ts) over a fake
// itx session and a door whose reads the test resolves BY HAND, so the heal window is a thing the
// test controls rather than a race it hopes for. The store's own reduce is the section above;
// this is the transport: the first paint's door read, gap heals SINGLE-FLIGHT, and a delta that
// lands WHILE a heal is in flight (the seed being read may predate it).

type Seed = LiveStateSeed<{ n: number }>;

/** A fake itx session (its `subscribe` hands the delivery callback to the test) and a door whose
 *  every read parks until the test answers it. */
function harness() {
  let deliver!: (events: unknown[], range: unknown) => void;
  const itx = {
    async subscribe(input: {
      name?: string;
      consumes?: string[];
      target: (events: unknown[], range: unknown) => void;
    }) {
      deliver = input.target;
      return { [Symbol.dispose]() {} };
    },
  };
  const doorReads: ((seed: Seed) => void)[] = [];
  return {
    itx,
    door: () => new Promise<Seed>((resolve) => doorReads.push(resolve)),
    doorReads,
    deliverDelta: (delta: LiveStateDelta) => deliver([{ payload: delta }], {}),
    deliverRaw: (payload: unknown) => deliver([{ payload }], {}),
    deliverEvents: (rawEvents: unknown[]) => deliver(rawEvents, {}),
  };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

test("a delta delivered WHILE a gap heal is in flight re-reads the door once the heal lands — the store converges on the producer, never sits behind it", async () => {
  const h = harness();
  const connecting = connectLiveState(h.itx, { key: "k", door: h.door });
  await settle();
  expect(h.doorReads).toHaveLength(1); // the first paint's door read
  h.doorReads[0]({ rev: 5, state: { n: 5 } });
  const connection = await connecting;
  expect(connection.store.rev()).toBe(5);

  // A gap (from 7, not 5): the store cannot apply onto a diverged base, so it heals — ONE door read.
  h.deliverDelta({ key: "k", from: 7, to: 8, patch: [{ op: "replace", path: "/n", value: 8 }] });
  await settle();
  expect(h.doorReads).toHaveLength(2);

  // The producer moves on WHILE that read is in flight. Heals are single-flight: no second read yet…
  h.deliverDelta({ key: "k", from: 8, to: 9, patch: [{ op: "replace", path: "/n", value: 9 }] });
  await settle();
  expect(h.doorReads).toHaveLength(2);

  // …but the heal answers with what the producer held when the read was SERVED — revision 8 — so
  // the client knows it is still behind and goes back to the door exactly once more.
  h.doorReads[1]({ rev: 8, state: { n: 8 } });
  await settle();
  expect(h.doorReads).toHaveLength(3);
  h.doorReads[2]({ rev: 9, state: { n: 9 } });
  await settle();
  expect(h.doorReads).toHaveLength(3); // a clean heal re-triggers nothing
  expect(connection.store.rev()).toBe(9);
  expect(connection.store.get()).toEqual({ n: 9 });
  await connection.dispose();
});

test("the first door read FAILING disposes the row it just configured — no callback is left lent to a connection nobody holds", async () => {
  let disposals = 0;
  const itx = {
    async subscribe() {
      return {
        [Symbol.dispose]() {
          disposals += 1;
        },
      };
    },
  };
  await expect(
    connectLiveState(itx, { key: "k", door: () => Promise.reject(new Error("door down")) }),
  ).rejects.toThrow("door down");
  expect(disposals).toBe(1);
});

test("an abort while the FIRST seed is still pending (a component unmounting) recalls the row just configured and rejects the connect — a door that never answers leaves nothing lent", async () => {
  let disposals = 0;
  const itx = {
    async subscribe() {
      return {
        [Symbol.dispose]() {
          disposals += 1;
        },
      };
    },
  };
  const unmounted = new AbortController();
  const connecting = connectLiveState(itx, {
    key: "k",
    door: () => new Promise<Seed>(() => {}), // never answers
    signal: unmounted.signal,
  });
  await settle();
  expect(disposals).toBe(0); // configured, waiting on the seed
  unmounted.abort();
  await expect(connecting).rejects.toThrow(/aborted/); // the signal's own reason (a DOMException)
  expect(disposals).toBe(1);
});

test("a malformed delta (a non-numeric rev) heals through the door instead of poisoning the held rev", async () => {
  const h = harness();
  const connecting = connectLiveState(h.itx, { key: "k", door: h.door });
  await settle();
  h.doorReads[0]({ rev: 5, state: { n: 5 } });
  const connection = await connecting;
  expect(connection.store.rev()).toBe(5);

  // A frame whose `to` is a numeric STRING would, if applied, become the held rev — then every later
  // valid frame reads as "behind" (dropped) and the client wedges forever. It must be rejected at the
  // boundary and healed through the door, exactly like a revision gap.
  h.deliverRaw({ key: "k", from: 5, to: "9999999999999999999", patch: [{ op: "replace", path: "/n", value: 9 }] });
  await settle();
  expect(connection.store.rev()).toBe(5); // NOT poisoned by the bogus rev
  expect(h.doorReads).toHaveLength(2); // healed via the door

  // After the heal, a well-formed frame still applies normally — the client is not wedged.
  h.doorReads[1]({ rev: 5, state: { n: 5 } });
  await settle();
  h.deliverDelta({ key: "k", from: 5, to: 6, patch: [{ op: "replace", path: "/n", value: 6 }] });
  await settle();
  expect(connection.store.rev()).toBe(6);
  expect(connection.store.get()).toEqual({ n: 6 });
  await connection.dispose();
});

test("an event with an OMITTED payload heals and does not skip a later valid delta in the batch", async () => {
  const h = harness();
  const connecting = connectLiveState(h.itx, { key: "k", door: h.door });
  await settle();
  h.doorReads[0]({ rev: 5, state: { n: 5 } });
  const connection = await connecting;
  expect(connection.store.rev()).toBe(5);

  // A batch whose FIRST event has no payload — `JSON.parse(JSON.stringify(undefined))` throws before
  // validation; an unguarded callback would throw out and drop the valid second delta. The decode is
  // guarded, so the malformed one heals (a door read) and the valid one still applies.
  h.deliverEvents([
    {}, // no payload key
    { payload: { key: "k", from: 5, to: 6, patch: [{ op: "replace", path: "/n", value: 6 }] } },
  ]);
  await settle();
  expect(connection.store.rev()).toBe(6); // the valid delta was NOT skipped
  expect(connection.store.get()).toEqual({ n: 6 });

  // The malformed event also kicked off a heal; answer it stale — monotonic seed must not move back.
  h.doorReads[1]?.({ rev: 5, state: { n: 5 } });
  await settle();
  expect(connection.store.rev()).toBe(6);
  await connection.dispose();
});
