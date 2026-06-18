// client.ts — the small client side: a socket opener plus `withItx`.
//
// There is deliberately NO path proxy for reads/calls: a naked Cap'n Web stub
// already turns `stub.slack.chat.postMessage(args)` into one pipelined message
// (the stub accumulates the property path locally, zero round trips, and sends it
// on the terminal call). The server-side dynamic proxy
// (`src/itx/path-invoker.ts`) collapses that path into one invokeCapability.
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

// Mirrors the public durable address types in `src/itx/processor-contract.ts`.
// Address-shaped values are
// forwarded as plain data; everything else is wrapped as a live provider. Host
// topology is deliberately not a client-providable address vocabulary.
const CAPABILITY_ADDRESS_TYPES = new Set(["worker-entrypoint", "durable-object"]);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isCapabilityAddress = (value: unknown) =>
  isPlainObject(value) &&
  typeof value.type === "string" &&
  CAPABILITY_ADDRESS_TYPES.has(value.type);

const replayLocalPath = (target: unknown, path: string[], args: unknown[] = []): unknown => {
  if (path.length === 0) {
    return typeof target === "function"
      ? (target as (...args: unknown[]) => unknown)(...args)
      : target;
  }
  let receiver = target;
  for (let i = 0; i < path.length - 1; i++) {
    if (receiver === null || (typeof receiver !== "object" && typeof receiver !== "function")) {
      throw new Error(`local capability path "${path.join(".")}" hit ${String(receiver)}`);
    }
    receiver = (receiver as Record<string, unknown>)[path[i]];
  }
  if (receiver === null || (typeof receiver !== "object" && typeof receiver !== "function")) {
    throw new Error(`local capability path "${path.join(".")}" hit ${String(receiver)}`);
  }
  const leaf = (receiver as Record<string, unknown>)[path.at(-1)!];
  if (typeof leaf !== "function") {
    throw new Error(`local capability path "${path.join(".")}" did not resolve to a function`);
  }
  return leaf(...args);
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
export const normalizeProvidedCapability = (capability: unknown): unknown => {
  if (isCapabilityAddress(capability)) return capability;

  if (capability && typeof capability === "object" && !isPlainObject(capability)) {
    const candidate = capability as { invokeCapability?: unknown };
    const invoke =
      typeof candidate.invokeCapability === "function"
        ? (input: { path: string[]; args?: unknown[] }) =>
            (
              candidate.invokeCapability as (input: { path: string[]; args?: unknown[] }) => unknown
            )(input)
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
  /** A project id like "prj_ref" (required — there is no global context). */
  projectId?: string;
  /** Context path inside the project. "/" is the project root. */
  path?: string;
  /** Bearer token naming the principal (auth.ts). Required for any context. */
  token?: string;
};

export function itxHttpUrl(input: WithItxInput): string {
  const base = input.baseUrl ?? process.env.ITX_BASE ?? "http://127.0.0.1:8788";
  const projectId = input.projectId ?? "";
  return `${base}/api/itx/${encodeURIComponent(projectId)}`;
}

export function itxWebSocketUrl(input: WithItxInput & { tokenInQuery?: boolean }): string {
  const base = input.baseUrl ?? process.env.ITX_BASE ?? "http://127.0.0.1:8788";
  const wsBase = base.replace(/^http/, "ws");
  const projectId = input.projectId ?? "";
  const params = new URLSearchParams();
  if (input.tokenInQuery && input.token) params.set("token", input.token);
  const qs = params.toString();
  return `${wsBase}/api/itx/${encodeURIComponent(projectId)}${qs ? `?${qs}` : ""}`;
}

/** Hold an itx context from OUTSIDE the platform (a Node program, a test, your
 *  laptop daemon). Returns a Disposable session stub with one write-side
 *  convenience: provideCapability normalizes raw local SDK objects before they
 *  cross RPC. Deep reads/calls still use the naked Cap'n Web path pipeline.
 *  `using itx = withItx(...)` closes the socket at scope end — and any live
 *  capability this connection provided is gone when it drops. */
type DisposableRpc = { [Symbol.dispose]?: () => void };
type ProvidedCapabilityArgs = { capability: unknown; [key: string]: unknown };
type ItxSession = DisposableRpc & {
  agents: { get(path: string): ItxSession };
  provideCapability(args: ProvidedCapabilityArgs): unknown;
};

export function withItx<T = unknown>(input: WithItxInput): T {
  const url = itxWebSocketUrl(input);
  const session = connect<ItxSession>(
    url,
    input.token ? { authorization: `Bearer ${input.token}` } : undefined,
  );
  const path = input.path ?? "/";
  const target = path === "/" ? session : session.agents.get(path);
  return new Proxy(target, {
    get(target, key, receiver) {
      if (key === Symbol.dispose)
        return () => {
          target[Symbol.dispose]?.();
          session[Symbol.dispose]?.();
        };
      if (key !== "provideCapability") return Reflect.get(target, key, receiver);
      return (args: ProvidedCapabilityArgs) =>
        target.provideCapability({
          ...args,
          capability: normalizeProvidedCapability(args.capability),
        });
    },
  }) as T;
}

// --- the admin-only platform root (src/itx/root.ts) ------------------------

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
  return `${wsBase}/api/itx${qs ? `?${qs}` : ""}`;
}

/** Connect to the admin Root ITX. No provide-time normalization is needed — the
 *  root has no provide surface; it is just `projects` + `streams`. */
export function withRoot<T = unknown>(input: WithRootInput = {}): T {
  return connect<T>(
    itxRootWebSocketUrl(input),
    input.token ? { authorization: `Bearer ${input.token}` } : undefined,
  );
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
