/**
 * Itx API worker: the capnweb surface at `/api/itx`, the
 * `/api/itx/admin-cookie` browser auth bridge, the worker-hosted e2e
 * fixtures, and project ingress — every lane `decideIngressRoute`
 * (src/ingress.ts) can resolve: the `/prj_<id>/...` path lane, project
 * platform hosts (with optional app selection), and directory-registered
 * custom hostnames.
 */
import { newHttpBatchRpcResponse, newWorkersWebSocketRpcResponse } from "capnweb";
import { trustedInternalAuthContext } from "../auth.ts";
import { e2eFixtureResponse } from "../e2e-fixtures.ts";
import type { Env } from "../env.ts";
import { decideIngressRoute, type IngressResolvers } from "../ingress.ts";
import { readProjectByHostname, resolveProjectIdBySlug } from "../project-directory.ts";
import {
  defaultProjectWorkerRef,
  ProjectCollectionRpcTarget,
  UnauthenticatedItxRpcTarget,
} from "../rpc-targets.ts";
import type { ProjectWorker } from "../types.ts";
import { handleCapnwebAdminCookieRequest } from "~/auth/admin-auth-cookie.ts";
import { parseConfig, type AppConfig } from "~/config.ts";

export { ItxEntrypoint } from "../domains/itx/itx-entrypoint.ts";
export { ProjectEgressEntrypoint } from "../domains/projects/egress.ts";

/** Long enough for warm-cache loads and quick bundles; past it, show the page. */
const PROJECT_HOST_BUILD_BUDGET_MS = 15_000;

function workerBuildingResponse(): Response {
  return new Response(
    `<!doctype html>
      <html>
        <head>
          <meta http-equiv="refresh" content="3" />
          <title>Building…</title>
        </head>
        <body>
          <main>
            <p>Your worker is building — this page retries automatically.</p>
          </main>
        </body>
      </html>`,
    {
      status: 503,
      headers: { "content-type": "text/html; charset=utf-8", "retry-after": "3" },
    },
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    // Parse config per request, not at module scope: workerd may reuse an
    // isolate across binding-only deploys, and a module-scope copy can serve
    // stale secrets after a rotation.
    const config = parseConfig(env as never);

    const fixtureResponse = await e2eFixtureResponse(request);
    if (fixtureResponse !== null) return fixtureResponse;

    const route = await decideIngressRoute({
      config,
      headers: request.headers,
      method: request.method,
      resolvers: directoryResolvers(config, env),
      url: request.url,
    });

    if (route.lane === "project") {
      const project = await new ProjectCollectionRpcTarget({
        auth: trustedInternalAuthContext(),
        ctx,
      }).get(route.resolved.projectId);
      const init: RequestInit = {
        body: request.body,
        headers: route.fetch.headers,
        method: route.fetch.method,
        redirect: request.redirect,
      };
      if (request.body !== null) {
        (init as RequestInit & { duplex: "half" }).duplex = "half";
      }
      // Browser-facing lane: a cold build (first use after a commit) should
      // show a refreshing "building" page rather than hang the request. The
      // budgeted worker stub throws a named error past the budget while the
      // build finishes into the artifact cache; refreshes then hit it.
      const worker = project.workers.get<ProjectWorker>(defaultProjectWorkerRef(), {
        buildBudgetMs: PROJECT_HOST_BUILD_BUDGET_MS,
        flattenNestedPaths: true,
      });
      try {
        return await worker.fetch(new Request(route.fetch.url, init));
      } catch (error) {
        if ((error as { name?: string } | null)?.name !== "WorkerBuildInProgressError") throw error;
        return workerBuildingResponse();
      }
    }

    if (route.lane === "notFound") {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    if (url.pathname === "/api/itx/admin-cookie") {
      return await handleCapnwebAdminCookieRequest({ config, request });
    }

    if (url.pathname !== "/api/itx") return Response.json({ error: "not found" }, { status: 404 });
    const unauthenticated = new UnauthenticatedItxRpcTarget({
      config,
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

function directoryResolvers(config: AppConfig, env: Env): IngressResolvers {
  return {
    projectIdBySlug: (identifier) =>
      resolveProjectIdBySlug({ config, directory: env.PROJECT_DIRECTORY, identifier }),
    projectByHostname: async (host) => {
      const found = await readProjectByHostname(env.PROJECT_DIRECTORY, host);
      return found ? { appSlug: found.appSlug, projectId: found.record.id } : null;
    },
  };
}
