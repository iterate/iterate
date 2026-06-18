import WebSocket from "ws";
import { newWebSocketRpcSession, type RpcCompatible, type RpcStub } from "capnweb";
import type { ProjectItxRpc, RootRpc } from "./itx-types.ts";

export type {
  AgentRpc,
  AgentsRpc,
  ItxProcessorRpc,
  ItxVerbsRpc,
  ProjectItxClient,
  ProjectItxRpc,
  ProjectRpc,
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
} from "./itx-types.ts";
export type { RpcCompatible, RpcStub } from "capnweb";

export const DEFAULT_ITX_BASE_URL = "http://127.0.0.1:8789";

export type WithItxInput = {
  baseUrl?: string;
  projectId?: string;
  token?: string;
};

export type WithRootInput = {
  baseUrl?: string;
  token?: string;
};

function baseUrl(input?: { baseUrl?: string }) {
  return (input?.baseUrl ?? process.env.ITX_BASE ?? DEFAULT_ITX_BASE_URL).replace(/\/+$/, "");
}

function websocketUrl(pathname: string, input: { baseUrl?: string }) {
  const url = new URL(pathname, baseUrl(input));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function itxWebSocketUrl(input: WithItxInput): string {
  const projectId = input.projectId ?? "";
  return websocketUrl(`/api/itx/${encodeURIComponent(projectId)}`, input);
}

export function itxRootWebSocketUrl(input: WithRootInput = {}): string {
  return websocketUrl("/api/itx", input);
}

export function connect<T extends RpcCompatible<T>>(
  url: string,
  headers?: Record<string, string>,
): RpcStub<T> {
  const socket = new WebSocket(url, headers ? { headers, handshakeTimeout: 10_000 } : undefined);
  return newWebSocketRpcSession<T>(
    socket as unknown as Parameters<typeof newWebSocketRpcSession>[0],
  );
}

export function withItx<T extends ProjectItxRpc = ProjectItxRpc>(input: WithItxInput): RpcStub<T> {
  return connect<T>(
    itxWebSocketUrl(input),
    input.token ? { authorization: `Bearer ${input.token}` } : undefined,
  );
}

export function withRoot<T extends RootRpc = RootRpc>(input: WithRootInput = {}): RpcStub<T> {
  return connect<T>(
    itxRootWebSocketUrl(input),
    input.token ? { authorization: `Bearer ${input.token}` } : undefined,
  );
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
