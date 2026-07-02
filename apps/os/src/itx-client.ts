import WebSocket from "ws";
import {
  newWebSocketRpcSession,
  type RpcCompatible as CapnRpcCompatible,
  type RpcStub as CapnRpcStub,
} from "capnweb";
import { withOwnedRpcSession } from "./domains/itx/utils.ts";
import type { Agent, ItxAuthCredentials, Itx, Session, UnauthenticatedItx } from "./types.ts";

export const DEFAULT_ITX_BASE_URL = "http://127.0.0.1:8791";

type ConnectItxBaseInput = {
  baseUrl?: string;
};

type ConnectItxAuthenticatedInput = ConnectItxBaseInput & {
  auth: ItxAuthCredentials;
};

type ConnectProjectItxInput = ConnectItxAuthenticatedInput & {
  projectId: string;
};

type ConnectAgentItxInput = ConnectItxAuthenticatedInput & {
  agentPath: string;
  projectId: string;
};

function websocketUrl(pathname: string, input: { baseUrl?: string }) {
  // ITX_API_PATH relocates the capnweb endpoint when a deployment serves it
  // somewhere other than /api/itx; standalone next workers keep the default.
  const apiPath = process.env.ITX_API_PATH ?? pathname;
  const url = new URL(
    pathname === "/api/itx" ? apiPath : pathname,
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

type RpcSessionStub<T extends object> = CapnRpcStub<T> & {
  [Symbol.dispose]?(): void;
  dup(): RpcSessionStub<T>;
};

export function connectItx(input: ConnectAgentItxInput): CapnRpcStub<Agent>;
export function connectItx(input: ConnectProjectItxInput): CapnRpcStub<Itx>;
export function connectItx(input: ConnectItxAuthenticatedInput): CapnRpcStub<Session>;
export function connectItx(input?: ConnectItxBaseInput): CapnRpcStub<UnauthenticatedItx>;
export function connectItx(
  input:
    | ConnectAgentItxInput
    | ConnectItxAuthenticatedInput
    | ConnectItxBaseInput
    | ConnectProjectItxInput = {},
): CapnRpcStub<Agent> | CapnRpcStub<Itx> | CapnRpcStub<Session> | CapnRpcStub<UnauthenticatedItx> {
  const session = connect<UnauthenticatedItx>(websocketUrl("/api/itx", input));
  if (!("auth" in input)) return session;

  const root = session.authenticate(input.auth) as CapnRpcStub<Session>;
  if (!("projectId" in input)) return withOwnedRpcSession(root, session);

  const project = root.projects.get(input.projectId) as RpcSessionStub<Itx>;
  if (!("agentPath" in input)) return withOwnedRpcSession(project, root, session);

  // An "agent itx" reached from outside `/api/itx` is just this agent's `Agent`
  // handle. It already carries the agent's own control surface plus the dynamic
  // capability scope chain (agent scope → project scope), so
  // `agent.someProvidedCapability()` resolves whether the capability was mounted
  // on the agent or on the project. Inside a Worker, `env.ITX.get()` returns the
  // richer full itx at the agent path; the external client keeps the narrower,
  // serialization-friendly Agent surface.
  const agent = project.agents.get(input.agentPath) as RpcSessionStub<Agent>;
  return withOwnedRpcSession(agent, project, root, session);
}
