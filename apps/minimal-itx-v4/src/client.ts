import WebSocket from "ws";
import {
  newWebSocketRpcSession,
  type RpcCompatible as CapnRpcCompatible,
  type RpcStub as CapnRpcStub,
} from "capnweb";
import type { Agent } from "./domains/agents/types.ts";
import { withOwnedRpcSession } from "./domains/itx/rpc-disposal.ts";
import type { ItxAuthCredentials, ItxRoot, UnauthenticatedItx } from "./domains/itx/types.ts";
import type { Project } from "./domains/projects/types.ts";

export const DEFAULT_ITX_BASE_URL = "http://127.0.0.1:8791";

type ConnectItxBaseInput = {
  baseUrl?: string;
};

type ConnectItxAuthenticatedInput = ConnectItxBaseInput & {
  auth: ItxAuthCredentials;
};

type ConnectProjectItxInput = ConnectItxAuthenticatedInput & {
  projectId: string;
  path?: "/";
};

type ConnectAgentItxInput = ConnectItxAuthenticatedInput & {
  agentPath: string;
  projectId: string;
};

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

export function connectItx(input: ConnectAgentItxInput): CapnRpcStub<Agent>;
export function connectItx(input: ConnectProjectItxInput): CapnRpcStub<Project>;
export function connectItx(input: ConnectItxAuthenticatedInput): CapnRpcStub<ItxRoot>;
export function connectItx(input?: ConnectItxBaseInput): CapnRpcStub<UnauthenticatedItx>;
export function connectItx(
  input:
    | ConnectAgentItxInput
    | ConnectItxAuthenticatedInput
    | ConnectItxBaseInput
    | ConnectProjectItxInput = {},
):
  | CapnRpcStub<Agent>
  | CapnRpcStub<ItxRoot>
  | CapnRpcStub<Project>
  | CapnRpcStub<UnauthenticatedItx> {
  const session = connect<UnauthenticatedItx>(websocketUrl("/api/itx", input));
  if (!("auth" in input)) return session;

  const root = session.authenticate(input.auth) as CapnRpcStub<ItxRoot>;
  if (!("projectId" in input)) return withOwnedRpcSession(root, session);

  const project = root.projects.get(input.projectId) as CapnRpcStub<Project>;
  if (!("agentPath" in input)) return withOwnedRpcSession(project, root, session);

  const agent = project.agents.get(input.agentPath) as CapnRpcStub<Agent>;
  return withOwnedRpcSession(agent, project, root, session);
}
