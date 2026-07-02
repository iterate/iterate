/**
 * Next-engine API worker: the capnweb surface at `/api/itx`, the
 * `/api/itx/admin-cookie` browser auth bridge, the worker-hosted e2e
 * fixtures, and project ingress — both the `/prj_<id>/...` path lane and
 * project platform hosts (`<slug>.<base>`), whose slugs resolve to project
 * ids through the auth worker's directory.
 */
import { newHttpBatchRpcResponse, newWorkersWebSocketRpcResponse } from "capnweb";
import { trustedInternalAuthContext } from "../auth.ts";
import { e2eFixtureResponse } from "../e2e-fixtures.ts";
import type { Env } from "../env.ts";
import { requestIngressHost } from "../ingress.ts";
import { ProjectCollectionRpcTarget, UnauthenticatedItxRpcTarget } from "../rpc-targets.ts";
import { handleCapnwebAdminCookieRequest } from "~/auth/admin-auth-cookie.ts";
import { createAuthWorkerServiceClient } from "~/auth/auth-worker-service.ts";
import { parseConfig, type AppConfig } from "~/config.ts";
import { parseProjectPlatformHosts } from "~/ingress/project-platform-host-routing.ts";

export { ItxEntrypoint } from "../domains/itx/itx-entrypoint.ts";
export { ProjectEgressEntrypoint } from "../domains/projects/egress.ts";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    // Parse config per request, not at module scope: workerd may reuse an
    // isolate across binding-only deploys, and a module-scope copy can serve
    // stale secrets after a rotation.
    const config = parseConfig(env as never);

    const fixtureResponse = await e2eFixtureResponse(request);
    if (fixtureResponse !== null) return fixtureResponse;

    const projectIngress = await projectIngressRequest({ config, request, url });
    if (projectIngress !== null) {
      const project = await new ProjectCollectionRpcTarget({
        auth: trustedInternalAuthContext(),
        ctx,
      }).get(projectIngress.projectId);
      return await project.worker.fetch(projectIngress.request);
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

/**
 * Project ingress: the `/prj_<id>/...` path lane (any host), else a project
 * platform host (`<slug>.<base>`) whose slug resolves through the auth
 * worker's directory. Returns the request to hand the project worker.
 */
async function projectIngressRequest(input: {
  config: AppConfig;
  request: Request;
  url: URL;
}): Promise<{ projectId: string; request: Request } | null> {
  const { request, url } = input;

  const [head, ...pathSegments] = url.pathname.split("/").filter(Boolean);
  if (head !== undefined && head.startsWith("prj_")) {
    const workerUrl = new URL(request.url);
    workerUrl.pathname = pathSegments.length === 0 ? "/" : `/${pathSegments.join("/")}`;
    return { projectId: head, request: projectWorkerRequest(workerUrl, request, head) };
  }

  const host = requestIngressHost(request);
  const candidates = parseProjectPlatformHosts({
    bases: input.config.projectHostnameBases ?? [],
    host,
  });
  for (const candidate of candidates) {
    const projectId = await resolveProjectId(input.config, candidate.projectIdentifier);
    if (!projectId) continue;
    return { projectId, request: projectWorkerRequest(new URL(request.url), request, projectId) };
  }

  return null;
}

function projectWorkerRequest(workerUrl: URL, request: Request, projectId: string): Request {
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
  return new Request(workerUrl, init);
}

// Slug → project id through the auth worker's directory. Ingress lookups are
// hot (every project-host request), so hits and misses are both cached
// briefly per isolate.
const PROJECT_ID_CACHE_TTL_MS = 30_000;
const projectIdCache = new Map<string, { expiresAt: number; projectId: string | null }>();

async function resolveProjectId(config: AppConfig, identifier: string): Promise<string | null> {
  if (identifier.startsWith("prj_")) return identifier;

  const cached = projectIdCache.get(identifier);
  if (cached && cached.expiresAt > Date.now()) return cached.projectId;

  const record = await createAuthWorkerServiceClient({ config })
    .project.bySlug({ projectSlug: identifier })
    .catch(() => null);
  const projectId = record?.id ?? null;
  projectIdCache.set(identifier, {
    expiresAt: Date.now() + PROJECT_ID_CACHE_TTL_MS,
    projectId,
  });
  return projectId;
}
