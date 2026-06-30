import WebSocket from "ws";
import {
  newWebSocketRpcSession,
  type RpcCompatible as CapnRpcCompatible,
  type RpcStub as CapnRpcStub,
} from "capnweb";
import type { Agent } from "./domains/agents/types.ts";
import { withOwnedRpcSession } from "./domains/itx/rpc-disposal.ts";
import type {
  AgentItx,
  ItxAuthCredentials,
  ItxRoot,
  UnauthenticatedItx,
} from "./domains/itx/types.ts";
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

type RpcSessionStub<T extends object> = CapnRpcStub<T> & {
  [Symbol.dispose]?(): void;
  dup(): RpcSessionStub<T>;
};

function agentItxStub(
  project: RpcSessionStub<Project>,
  agent: RpcSessionStub<Agent>,
): RpcSessionStub<AgentItx> {
  // The external `/api/itx` surface still exposes projects and agents as
  // separate RPC objects. This client-side view matches Worker `env.ITX.get()`
  // for agent contexts without adding another protocol branch.
  return new Proxy(project, {
    get(target, key, receiver) {
      if (key === "agent") return agent;
      if (key === "dup") return () => agentItxStub(target.dup(), agent.dup());
      if (key === Symbol.dispose) {
        return () => {
          target[Symbol.dispose]?.();
          agent[Symbol.dispose]?.();
        };
      }
      return Reflect.get(target, key, receiver);
    },
  }) as RpcSessionStub<AgentItx>;
}

export function connectItx(input: ConnectAgentItxInput): CapnRpcStub<AgentItx>;
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
  | CapnRpcStub<AgentItx>
  | CapnRpcStub<ItxRoot>
  | CapnRpcStub<Project>
  | CapnRpcStub<UnauthenticatedItx> {
  const session = connect<UnauthenticatedItx>(websocketUrl("/api/itx", input));
  if (!("auth" in input)) return session;

  const root = session.authenticate(input.auth) as CapnRpcStub<ItxRoot>;
  if (!("projectId" in input)) return withOwnedRpcSession(root, session);

  const project = root.projects.get(input.projectId) as RpcSessionStub<Project>;
  if (!("agentPath" in input)) return withOwnedRpcSession(project, root, session);

  const agent = project.agents.get(input.agentPath) as RpcSessionStub<Agent>;
  return withOwnedRpcSession(agentItxStub(project, agent), root, session);
}
