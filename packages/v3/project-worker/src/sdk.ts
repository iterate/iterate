// sdk.ts — THE userspace SDK surface, bundled (zod included) into every loaded processor
// isolate as `processor.js` by build-sdk.mjs. Userspace writes exactly what built-ins write:
//
//   import { StreamProcessor, defineProcessorContract, z } from "./processor.js";
//
// One contract shape, one base class, schemas everywhere (owner's call: isolates absolutely
// get zod and full contract schemas as part of the SDK).

export {
  StreamProcessor,
  type ProcessorContract,
  type ProcessorSnapshot,
  type ProcessorStream,
  type ProcessEventArgs,
  type ReduceArgs,
  type ScannedRange,
} from "./core/processor.ts";
export {
  defineProcessorContract,
  StreamEvent,
  StreamEventInput,
  jsonEqual,
} from "./core/events.ts";
export { z } from "zod";
export { applyPatch, diff, type PatchOp } from "./core/patch.ts";

// LIVE STATE — the one holder used two ways: a processor's base owns one internally (reduced state
// is live by default, override `projectLiveState` to fold in runtime fields), and a mini-app DO that
// is NOT a processor (a chatroom, a lobby) owns one directly: `new LiveState(env.ITX, "chat", {…})`,
// mutate with `set`, expose `snapshot()` as the client seed door. See core/live-state.ts.
export { LiveState, LIVE_STATE_CHANGED, type LiveStateSink } from "./core/live-state.ts";
