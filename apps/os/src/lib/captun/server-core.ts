import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import type {
  CaptunClientRemoteFetcher,
  CaptunServerAcceptTunnelOptions,
  CaptunServerTunnel,
} from "./types.ts";

export interface CaptunRemoteClient extends CaptunClientRemoteFetcher, Disposable {
  onRpcBroken(callback: () => void): void;
}

/**
 * No-op RpcTarget passed as the server's local main export so that the
 * capnweb RpcSession always has a defined, disposable hook at exports[0].
 *
 * Without this, `newWebSocketRpcSession(socket)` stores `undefined` as the
 * main hook.  When the WebSocket later closes, the session's `abort()` loop
 * calls `exports[i].hook.dispose()` on every entry — and
 * `undefined.dispose()` throws a TypeError.  That unhandled rejection
 * surfaces as `scriptThrewException` in Cloudflare analytics even though the
 * tunnel worked correctly from the client's perspective.
 */
class EmptyServerTarget extends RpcTarget {}

export function captunTunnelFromRemoteClient(
  remoteClient: CaptunRemoteClient,
  options: CaptunServerAcceptTunnelOptions,
): CaptunServerTunnel {
  remoteClient.onRpcBroken(() => options.onDisconnect?.());
  return {
    fetch: (request: Request) => remoteClient.fetch(request),
    [Symbol.dispose]: () => remoteClient[Symbol.dispose](),
  };
}

export function acceptCaptunTunnelFromSocket(
  socket: WebSocket,
  options: CaptunServerAcceptTunnelOptions = {},
): CaptunServerTunnel {
  const remoteClient = newWebSocketRpcSession(
    socket,
    new EmptyServerTarget(),
  ) as unknown as CaptunRemoteClient;
  return captunTunnelFromRemoteClient(remoteClient, options);
}
