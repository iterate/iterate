// e2e/support/setup.ts — per-file setup (setupFiles): resolve the one worker's URL (provided by
// global-setup) into an env var the client helper reads, and dispose each test's capnweb sessions
// afterwards (sessions left open at teardown turn into unhandled-rejection noise — the cloudflare-os
// lesson).

import { afterEach, inject } from "vitest";
import { Headers as UndiciHeaders, WebSocket as UndiciWebSocket } from "undici";
import { disposeSessions, workerAuthHeaders } from "./client.ts";

process.env.WORKER_BASE_URL = inject("workerBaseUrl");
process.env.WORKER_AUTH_COOKIE = inject("workerAuthCookie");
process.env.DUMMY_CAPNWEB_URL = inject("dummyCapnwebUrl");

// Browser-auth deployments require the session on every browser-shaped door,
// not only capnweb's `/api` helper. Local and anonymous deployed runs retain
// their native transports exactly; an authenticated wrapper never attaches a
// cookie to another origin.
if (process.env.WORKER_AUTH_COOKIE) {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    const auth = workerAuthHeaders(new URL(request.url));
    if (!auth) return nativeFetch(input, init);
    const headers = new Headers(request.headers);
    for (const [name, value] of Object.entries(auth)) headers.set(name, value);
    return nativeFetch(new Request(request, { headers }));
  };

  class AuthenticatedWebSocket extends UndiciWebSocket {
    constructor(url: string | URL, protocols?: ConstructorParameters<typeof UndiciWebSocket>[1]) {
      const auth = workerAuthHeaders(new URL(url));
      if (!auth) {
        super(url, protocols);
        return;
      }
      if (typeof protocols === "object" && !Array.isArray(protocols)) {
        const headers = Object.fromEntries(new UndiciHeaders(protocols.headers).entries());
        Object.assign(headers, auth);
        super(url, { ...protocols, headers });
        return;
      }
      super(url, { protocols, headers: auth });
    }
  }
  globalThis.WebSocket = AuthenticatedWebSocket as unknown as typeof globalThis.WebSocket;
}

afterEach(() => disposeSessions());
