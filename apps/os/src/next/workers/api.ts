/**
 * Next-engine API worker (coexistence deployment): serves the new capnweb
 * surface at `/api/itx`, the fake `/api/login` cookie endpoint, the
 * worker-hosted e2e fixtures, and the `/prj_<id>/...` project ingress path
 * lane. The os ingress/app workers forward `/api/itx-next` here (rewritten to
 * `/api/itx`), so the engine and its ported e2e suites run untouched while the
 * legacy stack keeps owning `/api/itx`.
 */
import { newHttpBatchRpcResponse, newWorkersWebSocketRpcResponse } from "capnweb";
import { trustedInternalAuthContext } from "../auth.ts";
import { e2eFixtureResponse } from "../e2e-fixtures.ts";
import type { Env } from "../env.ts";
import { ProjectCollectionRpcTarget, UnauthenticatedItxRpcTarget } from "../rpc-targets.ts";
import { parseConfig } from "~/config.ts";

export { ItxEntrypoint } from "../domains/itx/itx-entrypoint.ts";
export { ProjectEgressEntrypoint } from "../domains/projects/egress.ts";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    const fixtureResponse = await e2eFixtureResponse(request);
    if (fixtureResponse !== null) return fixtureResponse;

    const projectIngress = projectIngressRequest(request, url);
    if (projectIngress !== null) {
      const project = await new ProjectCollectionRpcTarget({
        auth: trustedInternalAuthContext(),
        ctx,
      }).get(projectIngress.projectId);
      return await project.worker.fetch(projectIngress.request);
    }

    if (url.pathname !== "/api/itx") return Response.json({ error: "not found" }, { status: 404 });
    // Parse config per request, not at module scope: workerd may reuse an
    // isolate across binding-only deploys, and a module-scope copy can serve
    // stale secrets after a rotation.
    const unauthenticated = new UnauthenticatedItxRpcTarget({
      config: parseConfig(env as never),
      ctx,
      headers: request.headers,
      requestUrl: request.url,
    });
    if (request.method === "POST") {
      return newHttpBatchRpcResponse(request, unauthenticated);
    }
    return newWorkersWebSocketRpcResponse(request, unauthenticated);
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
