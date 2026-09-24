import { newWebSocketRpcSession } from "capnweb";
import type { IterateApi } from "iterate/next/api";
import { readOsPlaywrightAuthConfig } from "./auth-config.ts";

/**
 * The operator's capnweb session on the OS platform under test: `/api` over a WebSocket, opened
 * bare and authenticated in-band with the deployment's admin bearer (`secrets.adminBearer`, which
 * setup.ts reads out of APP_CONFIG), the way apps/os/e2e/support/client.ts opens every e2e session.
 * Specs seed state through it instead of the UI where the state is not their subject. Dispose it.
 */
export function openOperatorSession() {
  const { adminApiSecret: secret, osBaseUrl } = readOsPlaywrightAuthConfig();
  const url = new URL("/api", osBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const api = newWebSocketRpcSession<IterateApi>(url.href);
  return {
    /** Every project (`{ actor: "admin" }`); with `as`, that person, found or created, with every
     *  scope: how a fixture makes a project the person owns (apps/os/src/session.ts). */
    authenticate: (as?: { email: string }) =>
      api.authenticate({ type: "admin-secret", secret, as }),
    [Symbol.dispose]: () => api[Symbol.dispose](),
  };
}

export type OperatorSession = ReturnType<typeof openOperatorSession>;
