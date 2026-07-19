import WebSocket from "ws";
import {
  newWebSocketRpcSession,
  type RpcCompatible as CapnRpcCompatible,
  type RpcStub as CapnRpcStub,
} from "capnweb";
import type {
  Agent,
  ItxAuthCredentials,
  Project,
  Session,
  UnauthenticatedOs,
} from "../itx-api.generated.ts";
import { apiWebSocketUrl } from "./api-url.ts";
import { withOwnedRpcSession } from "./owned-rpc-session.ts";

export type ItxWebSocketMessage = [timestamp: number, direction: "in" | "out", data: unknown];

const WEBSOCKET_OPENING_DEADLINE_MS = 15_000;

export class ItxWebSocketOpeningDeadlineError extends Error {
  override readonly name = "ItxWebSocketOpeningDeadlineError";

  constructor(timeoutMs: number) {
    super(`itx WebSocket did not complete its HTTP upgrade within ${timeoutMs}ms`);
  }
}

type OpeningWebSocketRequest = {
  destroy(error?: Error): unknown;
  end(): unknown;
  once(event: string, listener: () => void): unknown;
};

/**
 * Bound the entire opening request, including DNS lookup before Node assigns a
 * socket. `ws`'s handshakeTimeout becomes a socket timeout internally, so by
 * itself it cannot retire a lookup that never yields a socket.
 */
export function finishWebSocketRequestWithinDeadline(
  request: OpeningWebSocketRequest,
  timeoutMs = WEBSOCKET_OPENING_DEADLINE_MS,
): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => clearTimeout(timer);
  for (const event of ["upgrade", "response", "error", "close"] as const) {
    request.once(event, clear);
  }
  timer = setTimeout(() => {
    request.destroy(new ItxWebSocketOpeningDeadlineError(timeoutMs));
  }, timeoutMs);
  timer.unref?.();
  try {
    request.end();
  } catch (error) {
    clear();
    throw error;
  }
}

type ConnectItxBaseInput = {
  /** OS deployment base URL, e.g. the config's APP_CONFIG_BASE_URL. */
  baseUrl: string;
  /** Node WebSocket handshake headers, used by CLI/server callers with cookies. */
  headers?: Record<string, string>;
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
  headers?: Record<string, string>,
  onWebSocketMessage?: (message: ItxWebSocketMessage) => void,
): CapnRpcStub<T> {
  // 15s: cold deployments answer the upgrade only after the worker chain has
  // loaded, but #1601's route-healing + the preview slot warmup mean the first
  // upgrade lands in a few seconds — 15s is headroom, not a hang budget.
  const socket = new WebSocket(url, {
    finishRequest: (request) => finishWebSocketRequestWithinDeadline(request),
    handshakeTimeout: WEBSOCKET_OPENING_DEADLINE_MS,
    headers,
  });

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
export function connectItx(input: ConnectProjectItxInput): CapnRpcStub<Project>;
export function connectItx(input: ConnectItxAuthenticatedInput): CapnRpcStub<Session>;
export function connectItx(input: ConnectItxBaseInput): CapnRpcStub<UnauthenticatedOs>;
export function connectItx(
  input:
    | ConnectAgentItxInput
    | ConnectItxAuthenticatedInput
    | ConnectItxBaseInput
    | ConnectProjectItxInput,
):
  | CapnRpcStub<Agent>
  | CapnRpcStub<Project>
  | CapnRpcStub<Session>
  | CapnRpcStub<UnauthenticatedOs> {
  const session = connect<UnauthenticatedOs>(
    apiWebSocketUrl(input.baseUrl).toString(),
    input.headers,
    input.onWebSocketMessage,
  );
  if (!("auth" in input)) return session;

  const root = session.authenticate(input.auth) as CapnRpcStub<Session>;
  if (!("projectId" in input)) return withOwnedRpcSession(root, session);

  const project = root.projects.get(input.projectId) as RpcSessionStub<Project>;
  if (!("agentPath" in input)) return withOwnedRpcSession(project, root, session);

  // An "agent itx" reached from outside `/api` is just this agent's `Agent`
  // handle. It already carries the agent's own control surface plus the dynamic
  // capability scope chain (agent scope → project scope), so
  // `agent.someProvidedCapability()` resolves whether the capability was mounted
  // on the agent or on the project. Inside a Worker, `env.ITX.get()` returns the
  // richer full itx at the agent path; the external client keeps the narrower,
  // serialization-friendly Agent surface.
  const agent = project.agents.get(input.agentPath) as RpcSessionStub<Agent>;
  return withOwnedRpcSession(agent, project, root, session);
}
