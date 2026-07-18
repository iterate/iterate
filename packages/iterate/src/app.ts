// `iterate/app` — small server-side primitives for a userspace web app.
// The app owns its routes and capability graph: expose an unauthenticated
// RpcTarget from fetch(), authenticate explicitly, then return an app-defined
// session target. No framework wrapper hides that composition.
export { RpcTarget, newWorkersWebSocketRpcResponse } from "capnweb";
export {
  LiveState,
  LiveStateRpcTarget,
  type LiveStateRpc,
  type LiveStateRpcTargetOptions,
  type LiveStateSubscriptionHandle,
  type LiveUpdate,
} from "./live-state.ts";
