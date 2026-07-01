import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import WebSocket from "ws";
import { withOwnedRpcSession } from "../../src/next/domains/itx/utils.ts";
import type {
  Agent,
  ItxAuthCredentials,
  Itx,
  Session,
  UnauthenticatedItx,
} from "../../src/next/types.ts";

const DEFAULT_BASE_URL = "http://localhost:8791";

export type ItxWebSocketMessage = [timestamp: number, direction: "in" | "out", data: unknown];

type ItxSessionInput = {
  onWebSocketMessage?: (message: ItxWebSocketMessage) => void;
};

type AuthenticatedItxSessionInput = ItxSessionInput & {
  auth: ItxAuthCredentials;
};

type ProjectItxSessionInput = AuthenticatedItxSessionInput & {
  path?: "/";
  projectId: string;
};

type AgentItxSessionInput = AuthenticatedItxSessionInput & {
  agentPath: string;
  projectId: string;
};

export function buildUrl({
  path,
  protocol = "http",
}: {
  path: string;
  protocol?: "ws" | "http";
}): string {
  // Coexistence: the os deployment serves the next engine's capnweb surface
  // under /api/itx-next while the legacy stack still owns /api/itx. Suites set
  // ITX_API_PATH=/api/itx-next (see e2e vitest config); against a standalone
  // next worker the default /api/itx applies unchanged.
  const apiPath = process.env.ITX_API_PATH ?? "/api/itx";
  const mappedPath = path === "/api/itx" ? apiPath : path;
  const url = new URL(mappedPath, process.env.ITX_BASE_URL ?? DEFAULT_BASE_URL);
  if (protocol === "ws") {
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  }
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

/**
 * Returns a bog standard capnweb websocket RpcStub using newWebSocketRpcSession but allows
 * the caller to pass in a function to record the websocket messages.
 */
export function withItxSession(input: AgentItxSessionInput): RpcStub<Agent>;
export function withItxSession(input: ProjectItxSessionInput): RpcStub<Itx>;
export function withItxSession(input: AuthenticatedItxSessionInput): RpcStub<Session>;
export function withItxSession(input?: ItxSessionInput): RpcStub<UnauthenticatedItx>;
export function withItxSession(
  input:
    | AgentItxSessionInput
    | AuthenticatedItxSessionInput
    | ItxSessionInput
    | ProjectItxSessionInput = {},
): RpcStub<Agent> | RpcStub<Session> | RpcStub<Itx> | RpcStub<UnauthenticatedItx> {
  const socket = new WebSocket(buildUrl({ path: "/api/itx", protocol: "ws" }), {
    handshakeTimeout: 10_000,
  });

  const start = Date.now();
  const record = (direction: "in" | "out", data: unknown) => {
    input.onWebSocketMessage?.([Date.now() - start, direction, parseFrame(data)]);
  };

  const send = socket.send.bind(socket);
  socket.send = ((data: Parameters<WebSocket["send"]>[0], ...args: unknown[]) => {
    record("out", data);
    return send(data, ...(args as []));
  }) as WebSocket["send"];

  socket.on("message", (data) => record("in", data));

  const session = newWebSocketRpcSession<UnauthenticatedItx>(
    socket as unknown as Parameters<typeof newWebSocketRpcSession>[0],
  );
  if (!("auth" in input)) return session;

  const root = session.authenticate(input.auth) as RpcStub<Session>;
  if (!("projectId" in input)) return withOwnedRpcSession(root, session);

  const project = root.projects.get(input.projectId) as RpcStub<Itx>;
  if (!("agentPath" in input)) return withOwnedRpcSession(project, root, session);

  const agent = project.agents.get(input.agentPath) as RpcStub<Agent>;
  return withOwnedRpcSession(agent, project, root, session);
}
