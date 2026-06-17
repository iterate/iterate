// client.ts — the small client side: a socket opener plus `withItx`.
//
// There is deliberately NO path proxy for reads/calls: a naked Cap'n Web stub
// already turns `stub.slack.chat.postMessage(args)` into one pipelined message
// (the stub accumulates the property path locally, zero round trips, and sends it
// on the terminal call). The server-side dynamic proxy (server.ts) collapses that
// path into one invokeCapability.
//
// The only client-side convenience is on provideCapability: raw local SDK
// instances such as `new Slack.WebClient()` are not serializable Cap'n Web
// values. `withItx` wraps those local objects into a tiny path-call provider
// before they cross the socket, so the workshop-style example works through the
// ITX client while the kernel still only sees `{ invokeCapability({ path,args }) }`.
//
// Node-only by import (it passes a `ws` socket into Cap'n Web). A browser would
// hit the same `/api/itx` endpoint and use the same normalization rule.

import WebSocket from "ws";
import { newWebSocketRpcSession } from "capnweb";

// Mirrors the server's address types (itx.ts). Address-shaped values are
// forwarded as plain data; everything else is wrapped as a live provider. The
// trusted dialer types (`durable-object`, `worker-entrypoint`) are included so a
// provide naming them reaches the server's guard and gets a clear rejection,
// rather than being silently turned into a broken live cap.
const CAPABILITY_ADDRESS_TYPES = new Set([
  "rpc",
  "dynamic-worker",
  "dynamic-durable-object",
  "durable-object",
  "worker-entrypoint",
]);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isCapabilityAddress = (value: unknown) =>
  isPlainObject(value) &&
  typeof value.type === "string" &&
  CAPABILITY_ADDRESS_TYPES.has(value.type);

const replayLocalPath = (target: any, path: string[], args: unknown[] = []) => {
  if (path.length === 0) return typeof target === "function" ? target(...args) : target;
  let receiver = target;
  for (let i = 0; i < path.length - 1; i++) receiver = receiver[path[i]];
  return receiver[path.at(-1)!](...args);
};

/**
 * Cap'n Web can pass plain object graphs with function members, functions, and
 * RpcTarget stubs. It cannot serialize an arbitrary class instance such as
 * `new Slack.WebClient()` by value. For those local SDK instances, keep the real
 * object in this process and expose one live function stub:
 *
 *   invokeCapability({ path: ["chat", "postMessage"], args: [body] })
 *
 * The server treats that as a live path-call provider. When this socket closes,
 * the function stub dies and the capability becomes offline, which is the live
 * capability lifetime we want.
 */
export const normalizeProvidedCapability = (capability: any): any => {
  if (isCapabilityAddress(capability)) return capability;

  if (capability && typeof capability === "object" && !isPlainObject(capability)) {
    const invoke =
      typeof capability.invokeCapability === "function"
        ? (input: { path: string[]; args?: unknown[] }) => capability.invokeCapability(input)
        : (input: { path: string[]; args?: unknown[] }) =>
            replayLocalPath(capability, input.path, input.args ?? []);
    return {
      invokeCapability: invoke,
    };
  }

  return capability;
};

/** Open a Cap'n Web WebSocket session and return the naked stub. */
export function connect<T>(url: string, headers?: Record<string, string>): T {
  // `ws` (unlike a browser WebSocket) can set request headers on the upgrade —
  // that is how a Node client sends its `Authorization: Bearer …` token.
  const ws = new WebSocket(
    url,
    headers ? { headers } : undefined,
  ) as unknown as globalThis.WebSocket;
  return newWebSocketRpcSession<T>(ws);
}

export type WithItxInput = {
  /** Worker base url. Defaults to ITX_BASE or http://127.0.0.1:8788. */
  baseUrl?: string;
  /** A project id like "shared" (required — there is no global context). */
  projectId?: string;
  /** Context path inside the project. "/" is the project root. */
  path?: string;
  /** Bearer token naming the principal (auth.ts). Required for any context. */
  token?: string;
};

export function itxHttpUrl(input: WithItxInput): string {
  const base = input.baseUrl ?? process.env.ITX_BASE ?? "http://127.0.0.1:8788";
  const params = new URLSearchParams({
    projectId: input.projectId ?? "",
    path: input.path ?? "/",
  });
  return `${base}/api/itx?${params}`;
}

export function itxWebSocketUrl(input: WithItxInput & { tokenInQuery?: boolean }): string {
  const base = input.baseUrl ?? process.env.ITX_BASE ?? "http://127.0.0.1:8788";
  const wsBase = base.replace(/^http/, "ws");
  const params = new URLSearchParams({
    projectId: input.projectId ?? "",
    path: input.path ?? "/",
  });
  if (input.tokenInQuery && input.token) params.set("token", input.token);
  return `${wsBase}/api/itx?${params}`;
}

/** Hold an itx context from OUTSIDE the platform (a Node program, a test, your
 *  laptop daemon). Returns a Disposable session stub with one write-side
 *  convenience: provideCapability normalizes raw local SDK objects before they
 *  cross RPC. Deep reads/calls still use the naked Cap'n Web path pipeline.
 *  `using itx = withItx(...)` closes the socket at scope end — and any live
 *  capability this connection provided is gone when it drops. */
export function withItx<T = any>(input: WithItxInput): T {
  const url = itxWebSocketUrl(input);
  const session = connect<any>(
    url,
    input.token ? { authorization: `Bearer ${input.token}` } : undefined,
  );
  return new Proxy(session, {
    get(target, key, receiver) {
      if (key !== "provideCapability") return Reflect.get(target, key, receiver);
      return (args: { capability: unknown; [key: string]: unknown }) =>
        target.provideCapability({
          ...args,
          capability: normalizeProvidedCapability(args.capability),
        });
    },
  }) as T;
}

// --- the admin-only platform root (root-itx.ts) ----------------------------

export type WithRootInput = {
  /** Worker base url. Defaults to ITX_BASE or http://127.0.0.1:8788. */
  baseUrl?: string;
  /** Admin bearer token (auth.ts `access: "all"`). */
  token?: string;
  /** Browsers cannot set the upgrade header, so send the token as `?token=…`. */
  tokenInQuery?: boolean;
};

export function itxRootWebSocketUrl(input: WithRootInput = {}): string {
  const base = input.baseUrl ?? process.env.ITX_BASE ?? "http://127.0.0.1:8788";
  const wsBase = base.replace(/^http/, "ws");
  const params = new URLSearchParams();
  if (input.tokenInQuery && input.token) params.set("token", input.token);
  const qs = params.toString();
  return `${wsBase}/api/root${qs ? `?${qs}` : ""}`;
}

/** Connect to the admin Root ITX. No provide-time normalization is needed — the
 *  root has no provide surface; it is just `projects` + `streams`. */
export function withRoot<T = any>(input: WithRootInput = {}): T {
  return connect<T>(
    itxRootWebSocketUrl(input),
    input.token ? { authorization: `Bearer ${input.token}` } : undefined,
  );
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
