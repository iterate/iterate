// `iterate/live-state` — live state end to end: the snapshot+patch wire
// protocol, the structural diff that produces patches, the client store that
// reassembles them, and the SERVER engine (`LiveState`) that holds a value
// and pushes minimal diffs to retained RPC subscribers. No socket, no keeper
// — a Worker or Durable Object can import it without dragging the browser
// session machinery into its bundle.
export { createLiveStateStore } from "./itx/live-state/store.ts";
export { applyPatch, diff } from "./itx/live-state/diff.ts";
export type { LiveStatePatch, LiveUpdate } from "./itx/live-state/protocol.ts";
export { LiveState, type LiveStateSubscription } from "./itx/live-state/engine.ts";
export {
  disposeIgnoredRpcResult,
  isThenable,
  retainCallback,
  type RetainedCallback,
} from "./itx/rpc/retain.ts";
