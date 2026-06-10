// /api/itx — where credentials become handles (Law 3: auth happens at
// connect, nowhere else) and where Cap'n Web terminates (Law 7: in this
// stateless worker, never in a DO — the hibernation-ready seam).
//
// Routes:
//   GET/WS  /api/itx                  itx on the global context (access from principal)
//   GET/WS  /api/itx/:projectIdOrSlug itx on that project's context
//   POST    /api/itx/run              run an itx script in a loader isolate
//   POST    /api/itx/admin-cookie     test-only browser auth bridge (browsers
//                                     cannot set WebSocket Authorization headers)

import { newWorkersRpcResponse } from "capnweb";
import { resolveItx } from "./entrypoint.ts";
import { runItxScript } from "./run.ts";
import { GLOBAL_CONTEXT_ID, type ItxProps, type ProjectAccess } from "./protocol.ts";
import type { ItxRuntime } from "./handle.ts";
import { authenticateCapnwebAdmin, handleCapnwebAdminCookieRequest } from "./admin-auth-cookie.ts";
import { accessForPrincipal, requireWorkerExports, resolveAccessibleContextId } from "./access.ts";
import type { AppConfig } from "~/config.ts";
import type { RequestContext } from "~/request-context.ts";
import { createOsIterateAuth, resolveRequestAuth } from "~/auth/middleware.ts";
import type { Principal } from "~/auth/principal.ts";

export const ITX_PREFIX = "/api/itx";

export async function handleItxFetch(input: {
  config: AppConfig;
  context: RequestContext;
  env: Env;
  request: Request;
}): Promise<Response | null> {
  const url = new URL(input.request.url);
  if (url.pathname !== ITX_PREFIX && !url.pathname.startsWith(`${ITX_PREFIX}/`)) return null;
  const subpath = url.pathname.slice(ITX_PREFIX.length).replace(/^\//, "");

  if (subpath === "admin-cookie") {
    return await handleCapnwebAdminCookieRequest({ config: input.config, request: input.request });
  }

  const auth = await authenticateItxRequest(input);
  if (!auth.principal) return new Response("Unauthorized", { status: 401 });
  const access = accessForPrincipal(auth.principal);

  if (subpath === "run") {
    return await handleItxRun({ ...input, access });
  }

  // Bare prefix → global handle; anything else is a project id/slug or a
  // ctx_… child context id.
  let props: ItxProps;
  if (subpath === "") {
    // A global handle is safe for any authenticated principal: its access is
    // exactly what they can reach (admins → "all", users → their project
    // ids), and every built-in narrows through that access check — a user's
    // global handle can only itx.projects.get(...) their own projects, and
    // has no project to fetch/stream against until it narrows. The dangerous
    // case (a global /api/itx/run inheriting the platform's own egress) is
    // gated separately in handleItxRun, not here. This is also what makes the
    // global /itx-repl page work for normal logged-in users.
    props = { access, context: GLOBAL_CONTEXT_ID };
  } else {
    const resolved = await resolveAccessibleContextId({
      access,
      db: input.context.db,
      env: input.env,
      idOrSlug: decodeURIComponent(subpath),
    });
    if (!resolved) return new Response("Not Found", { status: 404 });
    props = { context: resolved.contextId };
  }

  const response = await newWorkersRpcResponse(
    input.request,
    await resolveItx({ env: input.env, exports: requireWorkerExports(input.context), props }),
  );
  const setCookie = auth.responseHeaders.get("set-cookie");
  if (setCookie) response.headers.append("set-cookie", setCookie);
  return response;
}

export const PROJECT_HOST_ITX_PATH = "/__itx";

/**
 * Project-host connect endpoint: wss://{project-host}/__itx returns an itx
 * already narrowed to that project. Cap'n Web terminates here in the
 * stateless worker (Law 7); the Project DO only ever sees Workers RPC.
 * Admin-credential only for now — user sessions connect via /api/itx on the
 * control plane host.
 */
export async function handleProjectHostItxFetch(input: {
  config: AppConfig;
  env: Env;
  exports: unknown;
  projectId: string;
  request: Request;
}): Promise<Response | null> {
  const pathname = new URL(input.request.url).pathname;
  if (pathname === `${PROJECT_HOST_ITX_PATH}/admin-cookie`) {
    return await handleCapnwebAdminCookieRequest({ config: input.config, request: input.request });
  }
  if (pathname !== PROJECT_HOST_ITX_PATH) return null;

  const principal = authenticateCapnwebAdmin({ config: input.config, request: input.request });
  if (!principal) return new Response("Unauthorized", { status: 401 });

  return await newWorkersRpcResponse(
    input.request,
    await resolveItx({
      env: input.env,
      exports: input.exports as ItxRuntime["exports"],
      props: { context: input.projectId },
    }),
  );
}

async function authenticateItxRequest(input: {
  config: AppConfig;
  context: RequestContext;
  request: Request;
}): Promise<{ principal: Principal | null; responseHeaders: Headers }> {
  const admin = authenticateCapnwebAdmin({ config: input.config, request: input.request });
  if (admin) return { principal: admin, responseHeaders: new Headers() };
  const resolved = await resolveRequestAuth({
    auth: createOsIterateAuth(input.context, input.request),
    context: input.context,
    request: input.request,
  });
  return { principal: resolved.principal, responseHeaders: resolved.responseHeaders };
}

// ---- /api/itx/run ----------------------------------------------------------
//
// Thin HTTP shim over the shared runner (run.ts): resolve + access-check the
// target context here (Law 3 — this is the auth boundary), then delegate.
// The runner leaves the two-event execution record on the project's /itx
// stream; the HTTP response carries the executionId so callers can correlate.

async function handleItxRun(input: {
  access: ProjectAccess;
  context: RequestContext;
  env: Env;
  request: Request;
}): Promise<Response> {
  if (!input.env.LOADER) {
    return Response.json({ error: "LOADER binding not available" }, { status: 503 });
  }

  const body = (await input.request.json()) as {
    context?: string;
    functionSource?: string;
    vars?: Record<string, unknown>;
  };
  if (typeof body.functionSource !== "string" || body.functionSource.trim() === "") {
    return Response.json({ error: "functionSource is required" }, { status: 400 });
  }

  let props: ItxProps;
  let scriptProjectId: string | null = null;
  if (body.context && body.context !== GLOBAL_CONTEXT_ID) {
    const resolved = await resolveAccessibleContextId({
      access: input.access,
      db: input.context.db,
      env: input.env,
      idOrSlug: body.context,
    });
    if (!resolved) return Response.json({ error: "Context not found" }, { status: 404 });
    props = { context: resolved.contextId };
    scriptProjectId = resolved.projectId;
  } else {
    // A global-context script inherits the platform's own egress (no
    // per-project globalOutbound), so it is admin-only — same rule as the
    // global connect handle.
    if (input.access !== "all") return Response.json({ error: "Forbidden" }, { status: 403 });
    props = { access: input.access, context: GLOBAL_CONTEXT_ID };
  }

  const outcome = await runItxScript({
    env: input.env,
    exports: requireWorkerExports(input.context),
    functionSource: body.functionSource,
    projectId: scriptProjectId,
    props,
    vars: body.vars,
  });
  if (!outcome.ok) {
    return Response.json(
      { error: outcome.error, executionId: outcome.executionId, stack: outcome.stack },
      { status: 500 },
    );
  }
  return Response.json({ executionId: outcome.executionId, result: outcome.result ?? null });
}
