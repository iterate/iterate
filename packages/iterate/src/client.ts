// `iterate/client` — the framework-free itx client.
//
// The one-socket session keeper (see ./itx/itx-session.ts for the model: one
// WebSocket per process, generations, invisible reconnect, terminal-auth
// parking, half-open verification) plus the shared wire pieces that ride it:
// the live-state snapshot+patch codec and the ownership-chain disposal helper.
// React bindings live in `iterate/react`; the node one-shot dial (ws, custom
// headers, frame observer) lives in `iterate/node`.
//
// In a browser the keeper needs no configuration (it dials the page's `/api`
// with cookie auth); everywhere else call `configureIterateSession` first.
export {
  configureIterateSession,
  connectIterateSession,
  connectItx,
  isItxTransportError,
  reconnectIterateSession,
  reportTransportSuspicion,
  watchItxSubscription,
  type Itx,
  type ItxLiveSubscriptionHandle,
  type IterateSessionConfig,
  type ProjectStub,
  type SessionStub,
} from "./itx/itx-session.ts";
export { withOwnedRpcSession } from "./itx/owned-rpc-session.ts";
export { createLiveStateStore } from "./itx/live-state/store.ts";
export { applyPatch, diff } from "./itx/live-state/diff.ts";
export type { LiveStatePatch, LiveUpdate } from "./itx/live-state/protocol.ts";
// The generated public contract (also exported by `iterate/sdk`): here so a
// client consumer needs exactly one import for handles AND their types.
// `.ts`-suffixed like every relative import here; tsc's
// rewriteRelativeImportExtensions keeps the declaration emit for the published
// dist/client.d.ts, where it must resolve to dist/itx-api.generated.d.ts.
export type * from "./itx-api.generated.ts";
