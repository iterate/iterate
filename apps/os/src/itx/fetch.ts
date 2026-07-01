// /api/itx — where credentials become handles (Law 3: auth happens at
// connect, nowhere else) and where Cap'n Web terminates (Law 7: in this
// stateless worker, never in a DO — the hibernation-ready seam).
//
// Routes:
//   GET/WS  /api/itx          itx on the global context (access from principal)
//   GET/WS  /api/itx/:target  itx on a context: a project id/slug (the
//                             project root context) or a full context ref
//                             (`<projectId>:/<path>`, URL-encoded)
//   POST    /api/itx/run      run an itx script in a loader isolate
//   POST    /api/itx/admin-cookie  test-only browser auth bridge (browsers
//                                  cannot set WebSocket Authorization headers)

import {
  newHttpBatchRpcResponse,
  newWorkersWebSocketRpcResponse,
  type RpcSessionOptions,
} from "capnweb";
import { resolveItx } from "./entrypoint.ts";
import { tagOutboundItxError } from "./errors.ts";
import { runItxScript } from "./run.ts";
import { GLOBAL_CONTEXT_ID, type ItxProps, type ProjectAccess } from "./refs.ts";
import { accessForPrincipal, requireWorkerExports, resolveAccessibleContextRef } from "./access.ts";
import { parseContextRef } from "./coordinates.ts";
import {
  authenticateCapnwebAdmin,
  handleCapnwebAdminCookieRequest,
} from "~/auth/admin-auth-cookie.ts";
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

  // Bare prefix → global handle; anything else is a project id/slug (the
  // project root context) or a full context ref.
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
    const ref = await resolveAccessibleContextRef({
      access,
      db: input.context.db,
      target: decodeURIComponent(subpath),
    });
    if (!ref) {
      return Response.json({ code: "NOT_FOUND", error: "Context not found" }, { status: 404 });
    }
    props = { context: ref };
  }

  const response = await newItxRpcResponse(
    input.request,
    await resolveItx({
      env: input.env,
      exports: requireWorkerExports(input.context),
      // The connect-time principal is threaded onto the GLOBAL handle ONLY (it
      // is minted here, never restored in an isolate), for itx.projects.create's
      // org-membership path. Project/context handles never see it.
      principal:
        subpath === "" && auth.principal?.type === "user"
          ? { userId: auth.principal.userId, organizations: auth.principal.organizations }
          : null,
      props,
    }),
  );
  const setCookie = auth.responseHeaders.get("set-cookie");
  if (setCookie) response.headers.append("set-cookie", setCookie);
  return response;
}

/**
 * capnweb's `newWorkersRpcResponse` convenience wrapper takes no
 * RpcSessionOptions (0.8.0), so this re-implements its POST/WebSocket
 * dispatch in order to pass `onSendError`: every error leaving an itx
 * session is tagged with an ItxError code (non-ItxErrors become INTERNAL),
 * and returning the error from the hook is what makes capnweb transmit its
 * stack — tag-don't-redact, see `tagOutboundItxError` (errors.ts).
 */
async function newItxRpcResponse(request: Request, localMain: unknown): Promise<Response> {
  const options: RpcSessionOptions = { onSendError: tagOutboundItxError };
  if (request.method === "POST") {
    const response = await newHttpBatchRpcResponse(request, localMain, options);
    response.headers.set("Access-Control-Allow-Origin", "*");
    return response;
  }
  if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    return newWorkersWebSocketRpcResponse(request, localMain, options);
  }
  return new Response("This endpoint only accepts POST or WebSocket requests.", { status: 400 });
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
// The runner leaves the two-event execution record on the context's own
// stream; the HTTP response carries the executionId so callers can correlate.

async function handleItxRun(input: {
  access: ProjectAccess;
  context: RequestContext;
  env: Env;
  request: Request;
}): Promise<Response> {
  if (!input.env.LOADER) {
    return Response.json(
      { code: "INTERNAL", error: "LOADER binding not available" },
      {
        status: 503,
      },
    );
  }

  const body = (await input.request.json()) as {
    context?: string;
    functionSource?: string;
    vars?: Record<string, unknown>;
  };
  if (typeof body.functionSource !== "string" || body.functionSource.trim() === "") {
    return Response.json(
      { code: "BAD_REQUEST", error: "functionSource is required" },
      {
        status: 400,
      },
    );
  }

  let props: ItxProps;
  let scriptProjectId: string | null = null;
  let scriptRecord: { projectId: string | null; path: string } | null = null;
  if (body.context && body.context !== GLOBAL_CONTEXT_ID) {
    const ref = await resolveAccessibleContextRef({
      access: input.access,
      db: input.context.db,
      target: body.context,
    });
    // NOT_FOUND covers both missing and forbidden contexts (existence
    // masking — same posture as ItxProjects.get, see errors.ts).
    if (!ref) {
      return Response.json({ code: "NOT_FOUND", error: "Context not found" }, { status: 404 });
    }
    props = { context: ref };
    const coordinate = parseContextRef(ref);
    scriptProjectId = coordinate.projectId;
    // The record lands on the context's own stream.
    scriptRecord = coordinate;
  } else {
    // A global-context script inherits the platform's own egress (no
    // per-project globalOutbound), so it is admin-only — same rule as the
    // global connect handle.
    if (input.access !== "all") {
      return Response.json({ code: "FORBIDDEN", error: "Forbidden" }, { status: 403 });
    }
    props = { access: input.access, context: GLOBAL_CONTEXT_ID };
  }

  // The endpoint's API is `({ itx, vars }) => …` + a vars object; the runner
  // knows ONE shape, `async (itx) => …`, so vars are baked into the source
  // here — parameterization is the caller's concern, not the runner's.
  const outcome = await runItxScript({
    env: input.env,
    exports: requireWorkerExports(input.context),
    functionSource: `async (itx) => (${body.functionSource})({ itx, vars: ${JSON.stringify(
      body.vars ?? {},
    )} })`,
    projectId: scriptProjectId,
    props,
    ...(scriptRecord ? { record: scriptRecord } : {}),
  });
  if (!outcome.ok) {
    // The script isolate flattens throws to JSON, so the ItxError code (when
    // the kernel threw one) rides along as a plain field; anything code-less
    // is INTERNAL, mirroring the capnweb sessions' tagging.
    return Response.json(
      {
        code: outcome.code ?? "INTERNAL",
        error: outcome.error,
        executionId: outcome.executionId,
        stack: outcome.stack,
      },
      { status: 500 },
    );
  }
  return Response.json({ executionId: outcome.executionId, result: outcome.result ?? null });
}
