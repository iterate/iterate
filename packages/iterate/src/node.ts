// `iterate/node` — the node-side one-shot itx dial.
//
// `connectItx(input)` dials an OS deployment's `/api` over the `ws` package
// (handshake timeout, custom headers for cookie-carrying callers, an optional
// frame observer for test recorders) and narrows to a Session, Project, or
// Agent stub via pipelined calls — no keeper, no reconnect: scripts and tests
// hold it with `using` and let disposal release the whole ownership chain.
// `connectItxReady(input)` waits for the WebSocket upgrade before constructing
// the RPC session. Callers may opt into exactly one observable pre-session
// retry; authentication and operations after return are never replayed.
// For a LONG-LIVED node/TUI connection use the keeper in `iterate/client`
// (`configureIterateSession` + `connectIterateSession`) instead.
export {
  connectItx,
  connectItxReady,
  type ConnectItxReadyOptions,
  type ItxInitialConnectionRetry,
  type ItxWebSocketMessage,
} from "./itx/itx-node-client.ts";
export { withOwnedRpcSession } from "./itx/owned-rpc-session.ts";
// `.ts`-suffixed like every relative import here; tsc's
// rewriteRelativeImportExtensions keeps the declaration emit for the published
// dist/node.d.ts, where it must resolve to dist/itx-api.generated.d.ts.
export type * from "./itx-api.generated.ts";
