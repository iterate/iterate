/**
 * Next-engine API worker (coexistence deployment): serves the new capnweb
 * surface at `/api/itx`, the fake `/api/login` cookie endpoint, the
 * worker-hosted e2e fixtures, and the `/prj_<id>/...` project ingress path
 * lane. The os ingress/app workers forward `/api/itx-next` here (rewritten to
 * `/api/itx`), so the engine and its ported e2e suites run untouched while the
 * legacy stack keeps owning `/api/itx`.
 */
import { newHttpBatchRpcResponse, newWorkersWebSocketRpcResponse } from "capnweb";
import type { Env } from "../env.ts";
import { ITX_AUTH_COOKIE, trustedInternalAuthContext } from "../auth.ts";
import { ProjectCollectionRpcTarget, UnauthenticatedItxRpcTarget } from "../rpc-targets.ts";
import { e2eFixtureResponse } from "../e2e-fixtures.ts";

export { ItxEntrypoint } from "../domains/itx/itx-entrypoint.ts";
export { ProjectEgressEntrypoint } from "../domains/projects/egress.ts";

export default {
  async fetch(request: Request, _env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // To test cookie auth, callers can post the JWT they'd like to have written as a cookie to /api/login
    // In this demo implementation of itx, we just trust the caller to pick their own jwt.
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

    const fixtureResponse = await e2eFixtureResponse(request);
    if (fixtureResponse !== null) return fixtureResponse;

    const projectIngress = projectIngressRequest(request, url);
    if (projectIngress !== null) {
      const project = new ProjectCollectionRpcTarget({
        auth: trustedInternalAuthContext(),
        ctx,
      }).get(projectIngress.projectId);
      return await project.worker.fetch(projectIngress.request);
    }

    if (url.pathname !== "/api/itx") return Response.json({ error: "not found" }, { status: 404 });
    if (request.method === "POST") {
      return newHttpBatchRpcResponse(
        request,
        new UnauthenticatedItxRpcTarget(request.headers, ctx),
      );
    }
    return newWorkersWebSocketRpcResponse(
      request,
      new UnauthenticatedItxRpcTarget(request.headers, ctx),
    );
  },
} satisfies ExportedHandler<Env>;

function projectIngressRequest(
  request: Request,
  url: URL,
): { projectId: string; request: Request } | null {
  const [projectId, ...pathSegments] = url.pathname.split("/").filter(Boolean);
  if (projectId === undefined || !projectId.startsWith("prj_")) return null;

  const workerUrl = new URL(request.url);
  workerUrl.pathname = pathSegments.length === 0 ? "/" : `/${pathSegments.join("/")}`;
  const headers = new Headers(request.headers);
  headers.set("x-itx-project-id", projectId);
  const init: RequestInit = {
    body: request.body,
    headers,
    method: request.method,
    redirect: request.redirect,
  };
  if (request.body !== null) {
    (init as RequestInit & { duplex: "half" }).duplex = "half";
  }

  return { projectId, request: new Request(workerUrl, init) };
}
