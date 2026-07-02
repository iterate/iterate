import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import WebSocket from "ws";
import { withOwnedRpcSession } from "../../src/domains/itx/utils.ts";
import type {
  Agent,
  ItxAuthCredentials,
  Itx,
  Session,
  UnauthenticatedItx,
} from "../../src/types.ts";

const DEFAULT_BASE_URL = "http://localhost:8791";

/**
 * The deployment admin API secret gating the `admin-secret` and `impersonate`
 * credential lanes. Provided by the Doppler config the suite runs under.
 */
export function adminSecret(): string {
  const secret = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim();
  if (!secret) {
    throw new Error("itx e2e needs APP_CONFIG_ADMIN_API_SECRET (run under doppler).");
  }
  return secret;
}

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
  // setup.ts resolves APP_CONFIG_BASE_URL (Doppler value or the local
  // dev-server discovery file) before any suite runs.
  const url = new URL(path, process.env.APP_CONFIG_BASE_URL ?? DEFAULT_BASE_URL);
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
