import WebSocket from "ws";
import {
  newWebSocketRpcSession,
  type RpcCompatible as CapnRpcCompatible,
  type RpcStub as CapnRpcStub,
} from "capnweb";
import { withOwnedRpcSession } from "./domains/itx/utils.ts";
import type { Agent, ItxAuthCredentials, Itx, Session, UnauthenticatedItx } from "./types.ts";

export type ItxWebSocketMessage = [timestamp: number, direction: "in" | "out", data: unknown];

type ConnectItxBaseInput = {
  /** OS deployment base URL, e.g. the config's APP_CONFIG_BASE_URL. */
  baseUrl: string;
  /** Observe every decoded ws frame (e.g. the e2e suite's frame recorder). */
  onWebSocketMessage?: (message: ItxWebSocketMessage) => void;
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

function websocketUrl(pathname: string, input: { baseUrl: string }) {
  const baseUrl = input.baseUrl?.trim();
  if (!baseUrl) {
    throw new Error("connectItx requires a baseUrl (the deployment's APP_CONFIG_BASE_URL).");
  }
  const url = new URL(pathname, baseUrl.replace(/\/+$/, ""));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/** Decode a raw ws frame (outbound string, inbound Buffer/ArrayBuffer) into its parsed JSON value. */
function parseFrame(data: unknown): unknown {
  const text =
    typeof data === "string"
      ? data
      : Buffer.isBuffer(data)
        ? data.toString("utf8")
        : ArrayBuffer.isView(data)
          ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8")
          : data instanceof ArrayBuffer
            ? Buffer.from(data).toString("utf8")
            : undefined;
  return text === undefined ? data : JSON.parse(text);
}

function connect<T extends CapnRpcCompatible<T>>(
  url: string,
  onWebSocketMessage?: (message: ItxWebSocketMessage) => void,
): CapnRpcStub<T> {
  const socket = new WebSocket(url, { handshakeTimeout: 10_000 });

  if (onWebSocketMessage) {
    const start = Date.now();
    const record = (direction: "in" | "out", data: unknown) => {
      onWebSocketMessage([Date.now() - start, direction, parseFrame(data)]);
    };
    const send = socket.send.bind(socket);
    socket.send = ((data: Parameters<WebSocket["send"]>[0], ...args: unknown[]) => {
      record("out", data);
      return send(data, ...(args as []));
    }) as WebSocket["send"];
    socket.on("message", (data) => record("in", data));
  }

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
export function connectItx(input: ConnectItxBaseInput): CapnRpcStub<UnauthenticatedItx>;
export function connectItx(
  input:
    | ConnectAgentItxInput
    | ConnectItxAuthenticatedInput
    | ConnectItxBaseInput
    | ConnectProjectItxInput,
): CapnRpcStub<Agent> | CapnRpcStub<Itx> | CapnRpcStub<Session> | CapnRpcStub<UnauthenticatedItx> {
  const session = connect<UnauthenticatedItx>(
    websocketUrl("/api/itx", input),
    input.onWebSocketMessage,
  );
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
