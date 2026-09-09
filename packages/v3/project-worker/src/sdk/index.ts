// sdk/index.ts — THE userspace SDK surface, bundled (zod included — the owner's call) into every
// loaded isolate as `processor.js` by build-sdk.mjs:
//
//   import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";

export {
  StreamProcessorDurableObject,
  type StreamProcessorProps,
} from "./stream-processor-durable-object.ts";
export {
  StreamProcessor,
  type ProcessorContract,
  type ProcessorStream,
  type ProcessEventArgs,
  type ReduceArgs,
  type ScannedRange,
} from "../stream/processor.ts";
export { ConfigWorker, type ConfigEventArgs, type ConfigWorkerItx } from "./config-worker.ts";
export { defineProcessorContract } from "./processor-contract.ts";
export { jsonEqual, type StreamEvent, type StreamEventInput } from "../stream/events.ts";
export { z } from "zod";
// capnweb's CLIENT constructors, so userspace can dial a remote capnweb API from inside its isolate
// through the context's own egress, and `newWorkersRpcResponse`, the SERVER half, so a loaded worker
// can serve a capnweb API over its `fetch`. The HTTP batch is exported ON PURPOSE beside the
// WebSocket session: a stateless entrypoint answering one method with one remote call has no session
// to hold across calls, and a one-shot POST is the honest shape (the lint rule targets long-lived workers).
// eslint-disable-next-line iterate/no-capnweb-http-batch -- userspace one-shot remote calls; see above
export { newHttpBatchRpcSession, newWebSocketRpcSession, newWorkersRpcResponse } from "capnweb";
export { applyPatch, diff, type PatchOp } from "../lib/patch.ts";

// LIVE STATE for a mini-app DO that is NOT a processor (a processor's base owns one internally):
// `new LiveState({ append: (e) => env.ITX.get().append(e) }, "chat", {…})` — a field initializer
// cannot await — then `set` to mutate and `snapshot()` as the client seed door (stream/live-state.ts).
export { LiveState, type LiveStateSink } from "../stream/live-state.ts";
