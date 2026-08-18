import WebSocket from "ws";
import { newWebSocketRpcSession, type RpcStub as CapnRpcStub } from "@iterate-com/capnweb";
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

export type ItxInitialConnectionRetry = {
  attemptDurationMs: number;
  delayMs: number;
  error: Error;
  failedAttempt: 1;
  nextAttempt: 2;
  startedAt: string;
};

export type ConnectItxReadyOptions = {
  /**
   * Permit exactly one fresh dial while establishing the initial WebSocket.
   *
   * The retry boundary ends before the RPC session exists, so it can never
   * replay authentication or a caller operation.
   */
  retryInitialConnection?: {
    /** Delay before the one retry. Defaults to 250ms; maximum 5s. */
    delayMs?: number;
    /** Observe the failed first dial before the retry begins. */
    onRetry?: (retry: ItxInitialConnectionRetry) => Promise<void> | void;
  };
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

function createSocket(
  url: string,
  headers?: Record<string, string>,
  onWebSocketMessage?: (message: ItxWebSocketMessage) => void,
): WebSocket {
  // 15s: cold deployments answer the upgrade only after the worker chain has
  // loaded, but #1601's route-healing + the preview slot warmup mean the first
  // upgrade lands in a few seconds — 15s is headroom, not a hang budget.
  const socket = new WebSocket(url, { handshakeTimeout: 15_000, headers });

  // PROTOCOL-LEVEL LIVENESS, because a genuinely quiet session dies. A
  // push-to-talk client between turns sends nothing for half a minute, and a
  // fully idle WebSocket through Cloudflare's edge was measured closing at
  // ~30s (1006) — which killed every round after the gap and, worse, let a
  // reconnecting session replay a stale press later. Ping frames are the
  // transport saying "still here" without one byte of application traffic;
  // the runtime answers them itself. Unref'd so an idle CLI still exits.
  socket.on("open", () => {
    const heartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }, 15_000);
    heartbeat.unref?.();
    socket.once("close", () => clearInterval(heartbeat));
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

  return socket;
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
  return createItxConnection(input, createItxSocket(input));
}

export function connectItxReady(
  input: ConnectAgentItxInput,
  options?: ConnectItxReadyOptions,
): Promise<CapnRpcStub<Agent>>;
export function connectItxReady(
  input: ConnectProjectItxInput,
  options?: ConnectItxReadyOptions,
): Promise<CapnRpcStub<Project>>;
export function connectItxReady(
  input: ConnectItxAuthenticatedInput,
  options?: ConnectItxReadyOptions,
): Promise<CapnRpcStub<Session>>;
export function connectItxReady(
  input: ConnectItxBaseInput,
  options?: ConnectItxReadyOptions,
): Promise<CapnRpcStub<UnauthenticatedOs>>;
export async function connectItxReady(
  input:
    | ConnectAgentItxInput
    | ConnectItxAuthenticatedInput
    | ConnectItxBaseInput
    | ConnectProjectItxInput,
  options: ConnectItxReadyOptions = {},
): Promise<
  CapnRpcStub<Agent> | CapnRpcStub<Project> | CapnRpcStub<Session> | CapnRpcStub<UnauthenticatedOs>
> {
  const retryOptions = options.retryInitialConnection;
  const delayMs = retryOptions === undefined ? 0 : initialRetryDelay(retryOptions.delayMs);

  for (const attempt of [1, 2] as const) {
    const startedAt = new Date();
    const startedAtPerformance = performance.now();
    const socket = createItxSocket(input);
    try {
      await waitForOpen(socket);
      return createItxConnection(input, socket);
    } catch (error) {
      if (attempt !== 1 || retryOptions === undefined) throw asError(error);
      await retryOptions.onRetry?.({
        attemptDurationMs: performance.now() - startedAtPerformance,
        delayMs,
        error: asError(error),
        failedAttempt: 1,
        nextAttempt: 2,
        startedAt: startedAt.toISOString(),
      });
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error("unreachable: initial itx connection retry exhausted");
}

function createItxSocket(
  input:
    | ConnectAgentItxInput
    | ConnectItxAuthenticatedInput
    | ConnectItxBaseInput
    | ConnectProjectItxInput,
): WebSocket {
  return createSocket(
    apiWebSocketUrl(input.baseUrl).toString(),
    input.headers,
    input.onWebSocketMessage,
  );
}

function createItxConnection(
  input:
    | ConnectAgentItxInput
    | ConnectItxAuthenticatedInput
    | ConnectItxBaseInput
    | ConnectProjectItxInput,
  socket: WebSocket,
):
  | CapnRpcStub<Agent>
  | CapnRpcStub<Project>
  | CapnRpcStub<Session>
  | CapnRpcStub<UnauthenticatedOs> {
  const session = newWebSocketRpcSession<UnauthenticatedOs>(
    socket as unknown as Parameters<typeof newWebSocketRpcSession>[0],
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

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  if (socket.readyState !== WebSocket.CONNECTING) {
    return Promise.reject(new Error("itx WebSocket closed before connecting"));
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("close", onClose);
      socket.off("error", onError);
      socket.off("open", onOpen);
    };
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      reject(new Error(`itx WebSocket closed before connecting: ${code} ${reason.toString()}`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    socket.once("close", onClose);
    socket.once("error", onError);
    socket.once("open", onOpen);
  });
}

function initialRetryDelay(value: number | undefined): number {
  const delayMs = value ?? 250;
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 5_000) {
    throw new Error(`Initial itx retry delay must be between 0 and 5000ms; received ${delayMs}.`);
  }
  return delayMs;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
