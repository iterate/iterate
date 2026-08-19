// sdk.ts — THE userspace SDK surface, bundled (zod included) into every loaded processor
// isolate as `processor.js` by build-sdk.mjs. Userspace writes exactly what built-ins write:
//
//   import { StreamProcessor, defineProcessorContract, z } from "./processor.js";
//
// One contract shape, one base class, schemas everywhere (owner's call: isolates absolutely
// get zod and full contract schemas as part of the SDK).

import { applyPatch, diff, type PatchOp } from "./core/patch.ts";

export {
  LIVE_STATE_CHANGED,
  StreamProcessor,
  type ProcessorContract,
  type ProcessorSnapshot,
  type ProcessorStream,
  type ProcessEventArgs,
  type ReduceArgs,
  type ScanWindow,
} from "./core/processor.ts";
export {
  defineProcessorContract,
  StreamEvent,
  StreamEventInput,
  jsonEqual,
} from "./core/events.ts";
export { z } from "zod";
export { applyPatch, diff, type PatchOp };

/** LIVE STATE for a mini-app that is NOT a stream processor (a chatroom DO, a game lobby):
 *  a tiny holder where MUTATION AND NOTIFICATION CANNOT BE SEPARATED — set() diffs old → new
 *  (as JSON: state must be a JSON value) and appends the (unconsumable, ephemeral) change
 *  event carrying the patch on the holder's own revision counter. `snapshot()` is the seed
 *  door — expose it as a method for clients to read {rev, state} through. A reborn holder
 *  restarts at rev 0 with `initial`: any client holding a later rev sees the chain break on
 *  the next set and re-reads the door — the state loss becomes visible, not papered over. */
export function liveState<S>(
  itx: { append(...e: unknown[]): unknown },
  key: string,
  initial: S,
): { get(): S; set(next: S): S; snapshot(): { rev: number; state: S } } {
  let state = initial;
  // The revision chain is seeded from a per-incarnation EPOCH, not 0: a reborn holder's chain
  // must never re-use an old chain's numbers, or a client that missed the first post-rebirth
  // frames would find `from` matching its held rev and apply a patch onto a diverged base —
  // silently, forever. With a fresh epoch every stale rev mismatches and re-reads the door.
  let rev = Date.now() * 4096 + Math.floor(Math.random() * 4096);
  return {
    get: () => state,
    snapshot: () => ({ rev, state }),
    set(next: S) {
      const patch = diff(state, next);
      state = next;
      if (!patch) return state;
      rev += 1;
      void Promise.resolve(
        itx.append({
          type: "events.iterate.com/live-state/changed",
          ephemeral: true,
          payload: { key, from: rev - 1, to: rev, patch },
        }),
      ).catch(() => {});
      return state;
    },
  };
}
