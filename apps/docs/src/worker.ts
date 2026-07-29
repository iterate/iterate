import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { env as workerEnv } from "cloudflare:workers";
import { newWorkersWebSocketRpcResponse } from "capnweb";
import type { AppEnv } from "./env.ts";
import { DocsApiRoot } from "./rpc-api.ts";

// The generated Wrangler config supplies this exact binding shape; the
// cloudflare:workers ambient export cannot carry an app-specific Env generic.
const env = workerEnv as unknown as AppEnv;

export default createServerEntry({
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    if (url.pathname === "/api") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Cap'n Web WebSocket only — upgrade required", { status: 426 });
      }
      return newWorkersWebSocketRpcResponse(request, new DocsApiRoot(env, request));
    }

    const response = await handler.fetch(request);
    if ((response.headers.get("content-type") ?? "").includes("text/html")) {
      const uncached = new Response(response.body, response);
      uncached.headers.set("cache-control", "no-store");
      return uncached;
    }
    return response;
  },
});
