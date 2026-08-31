// e2e/support/live-client.ts — the CLIENT half of live state, for E2E tests. Seed through the
// producer's door {rev, state}, apply each delivered {from, to, patch} whose `from` matches the held
// rev, re-read the door on any mismatch. Exposes the applied/dropped/reseeds counters the live-state
// proof asserts. Uses the real RFC-6902-subset applyPatch (src/core/patch.ts) — one patch impl.

import { applyPatch, type PatchOp } from "../../src/core/patch.ts";

/** One live-state change frame as delivered to a subscriber: apply `patch` iff `from` matches. */
export type Delta = { key?: string; from: number; to: number; patch: PatchOp[] };

export type LiveClient = {
  doc: unknown;
  rev: number | null;
  applied: number;
  dropped: number;
  reseeds: number;
  frames: Delta[];
  consume(u: Delta): void;
  seed(): Promise<void>;
};

type Door = () => Promise<{ rev: number; state: unknown }>;

/** `readDoor` reads `{rev, state}` (a processor's `liveSnapshot()`, a mini-app's `state()`). Feed each
 *  delivered delta to `consume`; call `seed()` once after subscribing. */
export const liveClient = (readDoor: Door): LiveClient => {
  const c: LiveClient & { queue: Delta[]; seeded: boolean } = {
    doc: undefined,
    rev: null,
    applied: 0,
    dropped: 0,
    reseeds: 0,
    queue: [],
    frames: [],
    seeded: false,
    consume(u) {
      c.frames.push(u);
      c.queue.push(u);
      if (c.seeded) void pump();
    },
    async seed() {
      ({ rev: c.rev, state: c.doc } = await readDoor());
      c.seeded = true;
      await pump();
    },
  };
  // SINGLE-FLIGHT: consume() during an in-flight door read must not start a second pump — two pumps
  // draining the queue against a stale c.rev would inflate the applied/dropped/reseeds counters the
  // tests assert on. The frame that arrived mid-read is drained by this pump's own while loop.
  let pumping = false;
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (c.queue.length) {
        const u = c.queue.shift()!;
        if (c.rev !== null && u.to <= c.rev) c.dropped++;
        else if (u.from === c.rev) {
          c.doc = applyPatch(c.doc, u.patch);
          c.rev = u.to;
          c.applied++;
        } else {
          c.reseeds++;
          ({ rev: c.rev, state: c.doc } = await readDoor());
        }
      }
    } finally {
      pumping = false;
    }
  };
  return c;
};
