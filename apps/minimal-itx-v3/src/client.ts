import WebSocket from "ws";
import { newWebSocketRpcSession, type RpcCompatible, type RpcStub } from "capnweb";
import type { UnauthenticatedItxRpc } from "./itx-types.ts";

export type {
  AgentRpc,
  AgentsRpc,
  AgentItxRpc,
  ItxConnectInput,
  ItxProcessorRpc,
  ItxVerbsRpc,
  ProjectItxClient,
  ProjectItxRpc,
  ProjectRpc,
  ProjectWorkerRpc,
  ProvideCapabilityInput,
  RepoRpc,
  ReposRpc,
  RootItxClient,
  RootProjectsRpc,
  RootRpc,
  RunScriptResult,
  StreamEvent,
  StreamEventInput,
  StreamRpc,
  StreamsRpc,
  UnauthenticatedItxClient,
  UnauthenticatedItxRpc,
} from "./itx-types.ts";
export type { ItxAuth, ItxAuthContext } from "./auth.ts";
export type { RpcCompatible, RpcStub } from "capnweb";

export const DEFAULT_ITX_BASE_URL = "http://127.0.0.1:8789";

export type ConnectItxInput = {
  baseUrl?: string;
};

function baseUrl(input?: { baseUrl?: string }) {
  return (input?.baseUrl ?? process.env.ITX_BASE ?? DEFAULT_ITX_BASE_URL).replace(/\/+$/, "");
}

function websocketUrl(pathname: string, input: { baseUrl?: string }) {
  const url = new URL(pathname, baseUrl(input));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function itxWebSocketUrl(input: ConnectItxInput = {}): string {
  return websocketUrl("/api/itx", input);
}

export function connect<T extends RpcCompatible<T>>(url: string): RpcStub<T> {
  const socket = new WebSocket(url, { handshakeTimeout: 10_000 });
  return newWebSocketRpcSession<T>(
    socket as unknown as Parameters<typeof newWebSocketRpcSession>[0],
  );
}

export function connectItx(input: ConnectItxInput = {}): RpcStub<UnauthenticatedItxRpc> {
  return connect<UnauthenticatedItxRpc>(itxWebSocketUrl(input));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
