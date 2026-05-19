import type { RpcTarget } from "capnweb";

/** Something that can handle a Fetch API request. */
export interface Fetcher {
  fetch(request: Request): Response | Promise<Response>;
}

/** Options for accepting a client WebSocket as a server-side tunnel. */
export interface CaptunServerAcceptTunnelOptions {
  /** Called when the underlying RPC connection breaks. */
  onDisconnect?: () => void;
}

/** Server-side handle for forwarding HTTP requests through an accepted tunnel. */
export interface CaptunServerTunnel extends Fetcher, Disposable {}

/** Client-side fetcher exposed to the server over the WebSocket RPC session. */
export interface CaptunClientRemoteFetcher extends Fetcher, RpcTarget {}
