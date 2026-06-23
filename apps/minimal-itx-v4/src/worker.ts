import { newHttpBatchRpcResponse, newWorkersWebSocketRpcResponse } from "capnweb";
import type { Env } from "./env.ts";
import { ITX_AUTH_COOKIE } from "./auth.ts";
// import { AgentDurableObject } from "./domains/agents/agent-durable-object.ts";
import { ProjectDurableObject } from "./domains/projects/project-durable-object.ts";
// import { RepoDurableObject } from "./domains/repos/repo-durable-object.ts";
import { StreamDurableObject } from "./domains/streams/stream-durable-object.ts";
import { ItxEntrypoint, UnauthenticatedItxRpcTarget } from "./rpc-targets.ts";

export default {
  async fetch(request: Request, _env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/login") {
      if (request.method !== "POST")
        return Response.json({ error: "method not allowed" }, { status: 405 });
      const token = await request.text();
      const cookie = [
        `${ITX_AUTH_COOKIE}=${encodeURIComponent(token)}`,
        "Path=/",
        "HttpOnly",
        url.protocol === "https:" ? "SameSite=None" : "SameSite=Lax",
        ...(url.protocol === "https:" ? ["Secure"] : []),
      ].join("; ");
      return Response.json({ ok: true }, { headers: { "set-cookie": cookie } });
    }

    if (url.pathname !== "/api/itx") return Response.json({ error: "not found" }, { status: 404 });
    if (request.method === "POST") {
      return newHttpBatchRpcResponse(request, new UnauthenticatedItxRpcTarget(request.headers));
    }
    return newWorkersWebSocketRpcResponse(
      request,
      new UnauthenticatedItxRpcTarget(request.headers),
    );
  },
} satisfies ExportedHandler<Env>;

export {
  ItxEntrypoint,
  // AgentDurableObject,
  ProjectDurableObject,
  // RepoDurableObject,
  StreamDurableObject,
};
