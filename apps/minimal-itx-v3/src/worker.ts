import { newWorkersWebSocketRpcResponse } from "capnweb";
import type { Env } from "./env.ts";
import { ITX_AUTH_COOKIE, readCookie } from "./auth.ts";
import { AgentDurableObject } from "./domains/agents/agent-durable-object.ts";
import { ProjectDurableObject } from "./domains/projects/project-durable-object.ts";
import { RepoDurableObject } from "./domains/repos/repo-durable-object.ts";
import { StreamDurableObject } from "./domains/streams/stream-durable-object.ts";
import { ItxEntrypoint, UnauthenticatedItx } from "./rpc_targets.ts";

function json(status: number, body: unknown) {
  return Response.json(body, { status });
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/login") {
      if (request.method !== "POST") return json(405, { error: "method not allowed" });
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

    if (url.pathname !== "/api/itx") return json(404, { error: "not found" });
    return newWorkersWebSocketRpcResponse(
      request,
      new UnauthenticatedItx(env, {
        serverCookieToken: readCookie(request.headers.get("cookie"), ITX_AUTH_COOKIE),
      }),
    );
  },
} satisfies ExportedHandler<Env>;

export {
  AgentDurableObject,
  ItxEntrypoint,
  ProjectDurableObject,
  RepoDurableObject,
  StreamDurableObject,
};
