import WebSocket from "ws";
import {
  newWebSocketRpcSession,
  type RpcCompatible as CapnRpcCompatible,
  type RpcStub as CapnRpcStub,
} from "capnweb";
import type { UnauthenticatedItx } from "../types-and-schemas.ts";

export type {
  Agent,
  Agent as AgentRpc,
  AgentItx,
  AgentItx as AgentItxRpc,
  Agents,
  Agents as AgentsRpc,
  ItxAuth,
  ItxAuthToken,
  ItxCapabilityHost,
  ItxConnectInput,
  JsonSerializableTrustMeBro,
  Project,
  Project as ProjectItxClient,
  Project as ProjectItxRpc,
  ProjectWorker,
  ProjectWorker as ProjectWorkerRpc,
  Repo,
  Repo as RepoRpc,
  Repos,
  Repos as ReposRpc,
  RootItx,
  RootItx as RootItxClient,
  RootItx as RootRpc,
  Stream,
  Stream as StreamRpc,
  StreamEvent,
  StreamEventInput,
  Streams,
  Streams as StreamsRpc,
  UnauthenticatedItx,
  UnauthenticatedItx as UnauthenticatedItxClient,
  UnauthenticatedItx as UnauthenticatedItxRpc,
} from "../types-and-schemas.ts";
export type { RpcCompatible, RpcStub } from "capnweb";
export type { ItxAuthContext } from "./auth.ts";

export const DEFAULT_ITX_BASE_URL = "http://127.0.0.1:8790";

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

export function connect<T extends CapnRpcCompatible<T>>(url: string): CapnRpcStub<T> {
  const socket = new WebSocket(url, { handshakeTimeout: 10_000 });
  return newWebSocketRpcSession<T>(
    socket as unknown as Parameters<typeof newWebSocketRpcSession>[0],
  );
}

export function connectItx(input: ConnectItxInput = {}): CapnRpcStub<UnauthenticatedItx> {
  return connect<UnauthenticatedItx>(itxWebSocketUrl(input));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
