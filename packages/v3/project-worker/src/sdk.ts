// sdk.ts — THE userspace SDK surface, bundled (zod included) into every loaded processor
// isolate as `processor.js` by build-sdk.mjs. Userspace writes exactly what built-ins write:
//
//   import { StreamProcessor, defineProcessorContract, z } from "./processor.js";
//
// One contract shape, one base class, schemas everywhere (owner's call: isolates absolutely
// get zod and full contract schemas as part of the SDK).

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

/** LIVE STATE for a mini-app that is NOT a stream processor (a chatroom DO, a game lobby):
 *  a tiny holder where MUTATION AND NOTIFICATION CANNOT BE SEPARATED — set() updates the value
 *  AND appends the (unconsumable, ephemeral) nudge. The author's own accessor method is the
 *  seed door subscribers re-pull through. */
export function liveState<S>(
  itx: { append(...e: unknown[]): unknown },
  key: string,
  initial: S,
): { get(): S; set(next: S): S } {
  let state = initial;
  return {
    get: () => state,
    set(next: S) {
      state = next;
      void Promise.resolve(
        itx.append({
          type: "events.iterate.com/live-state/changed",
          ephemeral: true,
          payload: { key },
        }),
      ).catch(() => {});
      return state;
    },
  };
}
