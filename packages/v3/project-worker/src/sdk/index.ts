// sdk/index.ts — THE userspace SDK surface, bundled (zod included) into every loaded processor
// isolate as `processor.js` by build-sdk.mjs. Userspace writes exactly what built-ins write:
//
//   import { StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";
//
// One contract shape, one base class, schemas everywhere (owner's call: isolates absolutely
// get zod and full contract schemas as part of the SDK).

export {
  StreamProcessorDurableObject,
  type ItxBinding,
  type StreamProcessorProps,
} from "./stream-processor-durable-object.ts";
export {
  type ProcessorContract,
  type ProcessorSnapshot,
  type ProcessorStream,
  type ProcessEventArgs,
  type ReduceArgs,
  type ScannedRange,
} from "../stream/processor.ts";
export {
  defineProcessorContract,
  StreamEvent,
  StreamEventInput,
  jsonEqual,
} from "../stream/events.ts";
export { z } from "zod";
// capnweb's CLIENT constructors, so userspace can dial a remote capnweb API from inside its isolate
// through the context's own egress — `itx.provide("itx.os", "itx.load(src).getEntrypoint('Remote',
// { props: { url } })")`. The server half is not here: inside workerd a class extends `RpcTarget`
// from "cloudflare:workers". The HTTP batch is exported ON PURPOSE beside the WebSocket session: a
// stateless entrypoint answering one method with one remote call has no session to hold across
// calls, and a one-shot POST is the honest shape for it (the lint rule targets long-lived workers).
// eslint-disable-next-line iterate/no-capnweb-http-batch -- userspace one-shot remote calls; see above
export { newHttpBatchRpcSession, newWebSocketRpcSession } from "capnweb";
export { applyPatch, diff, type PatchOp } from "../lib/patch.ts";

// LIVE STATE — the one holder used two ways: a processor's base owns one internally (reduced state
// is live by default, override `projectLiveState` to fold in runtime fields), and a mini-app DO that
// is NOT a processor (a chatroom, a lobby) owns one directly: `new LiveState(env.ITX, "chat", {…})`,
// mutate with `set`, expose `snapshot()` as the client seed door. See stream/live-state.ts.
export { LiveState, type LiveStateSink } from "../stream/live-state.ts";
