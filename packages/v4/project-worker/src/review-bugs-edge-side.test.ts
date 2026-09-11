// review-bugs-edge-side.test.ts — RED PROOFS from the 2026-09-02 edge/rpc-stub bug hunt
// (docs/reviews/2026-09-02-bugs-edge-side.md). Pure-logic half: the shipped browser client
// (client/live-state-client.ts + client/live-state-store.ts). Every test here is `test.fails`
// (the house convention for a known-red proof — the lane stays green); the comment block above
// each one is the whole finding.

import { expect, test } from "vitest";
import { connectLiveState } from "./client/live-state-client.ts";
import type { LiveStateDelta, LiveStateSeed } from "./client/live-state-store.ts";

type Seed = LiveStateSeed<{ n: number }>;

/** A fake itx session + a door whose reads the test resolves by hand, so the heal window is a
 *  thing the test controls rather than a race it hopes for. */
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
  };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

// BUG: a live-state delta delivered WHILE a gap heal is in flight is dropped forever, so the store
//      can sit permanently behind the producer.
// WHY: connectLiveState's `reseed` is single-flight (`if (healing || disposed) return`) and the
//      dropped delta leaves NO record — `store.apply` just calls `resync()` and returns. The heal's
//      door read can legitimately have been SERVED BEFORE that delta was produced (the door read and
//      the delivery are independent channels), so the seed it lands is older than the delta that was
//      dropped. Nothing re-triggers: the comment's "the next delivered delta re-triggers" is only
//      true if the producer happens to emit another one.
// EXPECTED: a delta that could not be applied because a heal was already running must leave the
//      connection knowing it is still behind — one more door read after the heal lands (or the
//      delta queued and applied), so the store converges on the producer's revision.
test("live-state: a delta delivered during a gap heal is dropped and never re-triggers — the store stays behind the producer", async () => {
  const h = harness();
  const connecting = connectLiveState(h.itx, { key: "k", door: h.door });
  await settle();
  expect(h.doorReads).toHaveLength(1); // the first paint's door read
  h.doorReads[0]({ rev: 5, state: { n: 5 } });
  const connection = await connecting;
  expect(connection.store.rev()).toBe(5);

  // A gap (from 7, not 5) — the store cannot apply onto a diverged base, so it heals.
  h.deliverDelta({ key: "k", from: 7, to: 8, patch: [{ op: "replace", path: "/n", value: 8 }] });
  await settle();
  expect(h.doorReads).toHaveLength(2); // the heal's door read is out, unanswered

  // The producer moves on WHILE that read is in flight. This frame is dropped on the floor.
  h.deliverDelta({ key: "k", from: 8, to: 9, patch: [{ op: "replace", path: "/n", value: 9 }] });
  await settle();

  // The heal answers with what the producer held when the read was SERVED — revision 8.
  h.doorReads[1]({ rev: 8, state: { n: 8 } });
  await settle();

  // The client saw a frame that carried the producer to 9 and could not use it, so it must go
  // back to the door. Today it does not: doorReads stays at 2 and the store is stuck at 8 with
  // n:8 while the producer is at 9 with n:9 — for as long as the producer stays quiet.
  expect(h.doorReads.length).toBeGreaterThan(2);
});
