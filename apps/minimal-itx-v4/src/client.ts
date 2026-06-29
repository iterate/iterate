import WebSocket from "ws";
import {
  newWebSocketRpcSession,
  type RpcCompatible as CapnRpcCompatible,
  type RpcStub as CapnRpcStub,
} from "capnweb";
import type { UnauthenticatedItx } from "./domains/itx/types.ts";

export const DEFAULT_ITX_BASE_URL = "http://127.0.0.1:8791";

function websocketUrl(pathname: string, input: { baseUrl?: string }) {
  const url = new URL(
    pathname,
    (input.baseUrl ?? process.env.ITX_BASE ?? DEFAULT_ITX_BASE_URL).replace(/\/+$/, ""),
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function connect<T extends CapnRpcCompatible<T>>(url: string): CapnRpcStub<T> {
  const socket = new WebSocket(url, { handshakeTimeout: 10_000 });
  return newWebSocketRpcSession<T>(
    socket as unknown as Parameters<typeof newWebSocketRpcSession>[0],
  );
}

export function connectItx(input: { baseUrl?: string } = {}): CapnRpcStub<UnauthenticatedItx> {
  return connect<UnauthenticatedItx>(websocketUrl("/api/itx", input));
}
