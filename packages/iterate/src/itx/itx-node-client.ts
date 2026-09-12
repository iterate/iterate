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
  /**
   * Observe the returned connection closing. Failed pre-ready dials use onRetry.
   *
   * A client whose job is to stay connected (a device, a long-lived agent)
   * reconnects from HERE — the moment the transport dies — not lazily when
   * its next call fails. The hook is a passive observer: this client stays
   * vanilla capnweb and never reconnects, pings, or retries by itself; the
   * consumer owns that loop.
   */
  onWebSocketClose?: (close: { code: number; reason: string }) => void;
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
  onWebSocketClose?: (close: { code: number; reason: string }) => void,
): WebSocket {
  // 15s: cold deployments answer the upgrade only after the worker chain has
  // loaded, but #1601's route-healing + the preview slot warmup mean the first
  // upgrade lands in a few seconds — 15s is headroom, not a hang budget.
  const socket = new WebSocket(url, { handshakeTimeout: 15_000, headers });

  observeSocketClose(socket, onWebSocketClose);

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

function observeSocketClose(
  socket: WebSocket,
  onWebSocketClose: ConnectItxBaseInput["onWebSocketClose"],
): void {
  if (onWebSocketClose) {
    socket.once("close", (code, reason) => onWebSocketClose({ code, reason: reason.toString() }));
  }
}

type RpcSessionStub<T extends object> = CapnRpcStub<T> & {
  [Symbol.dispose]?(): void;
  dup(): RpcSessionStub<T>;
};

type SocketOwner = {
  [Symbol.dispose](): void;
  dup(): SocketOwner;
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
  return createItxConnection(input, createItxSocket(input, input.onWebSocketClose));
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
      const connection = createItxConnection(input, socket);
      observeSocketClose(socket, input.onWebSocketClose);
      return connection;
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
  onWebSocketClose?: ConnectItxBaseInput["onWebSocketClose"],
): WebSocket {
  return createSocket(
    apiWebSocketUrl(input.baseUrl).toString(),
    input.headers,
    input.onWebSocketMessage,
    onWebSocketClose,
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
  try {
    // Node ws implements the WebSocket operations Cap'n Web uses; its DOM type
    // declaration differs, so adapt that library boundary here.
    const session = newWebSocketRpcSession<UnauthenticatedOs>(
      socket as unknown as Parameters<typeof newWebSocketRpcSession>[0],
    );
    const socketOwner = createSocketOwner(socket, session);
    if (!("auth" in input)) {
      return createSocketOwnedSession<UnauthenticatedOs>(session, socketOwner);
    }

    // The generated API describes remote return values. Cap'n Web pipelines
    // those calls into stubs, retaining their dispose/dup ownership operations.
    const root = session.authenticate(input.auth) as CapnRpcStub<Session>;
    if (!("projectId" in input)) return withOwnedRpcSession(root, socketOwner);

    // Project lookup is another pipelined RPC stub with the same ownership API.
    const project = root.projects.get(input.projectId) as RpcSessionStub<Project>;
    if (!("agentPath" in input)) return withOwnedRpcSession(project, root, socketOwner);

    // An "agent itx" reached from outside `/api` is just this agent's `Agent`
    // handle. It already carries the agent's own control surface plus the dynamic
    // capability scope chain (agent scope → project scope), so
    // `agent.someProvidedCapability()` resolves whether the capability was mounted
    // on the agent or on the project. Inside a Worker, `env.ITX.get()` returns the
    // richer full itx at the agent path; the external client keeps the narrower,
    // serialization-friendly Agent surface.
    // Agent lookup likewise returns a pipelined stub, rather than a local Agent.
    const agent = project.agents.get(input.agentPath) as RpcSessionStub<Agent>;
    return withOwnedRpcSession(agent, project, root, socketOwner);
  } catch (error) {
    socket.close(1000);
    throw error;
  }
}

/**
 * One returned scoped itx handle owns one reference to the physical socket.
 * `withOwnedRpcSession()` duplicates every owned value, so each duplicated
 * handle retains its own reference and the last disposal closes the transport.
 */
function createSocketOwner(
  socket: WebSocket,
  session: RpcSessionStub<UnauthenticatedOs>,
): SocketOwner {
  let references = 0;
  const retain = () => {
    references += 1;
    let disposed = false;
    return {
      dup: retain,
      [Symbol.dispose]: () => {
        if (disposed) return;
        disposed = true;
        references -= 1;
        if (references !== 0) return;
        // Cap'n Web turns disposal of its bootstrap stub into a 3000 abort.
        // Start the normal close first, then dispose the session so local
        // pending imports are rejected without replacing the close code.
        socket.close(1000);
        session[Symbol.dispose]?.();
      },
    };
  };
  return retain();
}

function createSocketOwnedSession<T extends object>(
  session: RpcSessionStub<T>,
  socketOwner: SocketOwner,
): RpcSessionStub<T> {
  return new Proxy(session, {
    get(target, key, receiver) {
      if (key === "then") return undefined;
      if (key === Symbol.dispose) return () => socketOwner[Symbol.dispose]?.();
      if (key === "dup") {
        return () => createSocketOwnedSession(session, socketOwner.dup());
      }
      return Reflect.get(target, key, receiver);
    },
  });
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
