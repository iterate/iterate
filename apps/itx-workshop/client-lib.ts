// client-lib.ts — shared helpers for the Node clients.
import WebSocket from "ws";
import { newWebSocketRpcSession } from "capnweb";

// capnweb's newWebSocketRpcSession wants a browser-style WebSocket. The `ws`
// package is close enough; we just need addEventListener/send/close/readyState.
// In practice capnweb attaches via .addEventListener("message"/"open"/...).
export function connect<T>(url: string): T {
  const ws = new WebSocket(url) as unknown as globalThis.WebSocket;
  return newWebSocketRpcSession<T>(ws);
}

// Consumer-side PathProxy (Step 6, the version the workshop says is REQUIRED):
// each property access accumulates a path locally (zero round trips); the
// terminal call sends ONE invoke(path, args).
const PP_RESERVED = new Set(["then", "__proto__", "constructor", "prototype"]);

export function pathProxy(
  invoke: (path: string[], args: unknown[]) => unknown,
  path: string[] = [],
): any {
  return new Proxy(function () {}, {
    get(_t, key) {
      if (typeof key === "symbol") return undefined;
      if (key === "then") return undefined; // so `await itx.slack` doesn't hang
      if (PP_RESERVED.has(key)) return undefined;
      return pathProxy(invoke, [...path, key]);
    },
    apply(_t, _s, args) {
      return invoke(path, args as unknown[]);
    },
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
