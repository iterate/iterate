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
import { GLOBAL_CONTEXT_ID, type ItxProps, type ProjectAccess } from "./protocol.ts";
import type { ItxRuntime } from "./handle.ts";
import { authenticateCapnwebAdmin, handleCapnwebAdminCookieRequest } from "./admin-auth-cookie.ts";
import type { AppConfig } from "~/app.ts";
import type { AppContext } from "~/context.ts";
import { createOsIterateAuth, resolveRequestAuth } from "~/auth/middleware.ts";
import type { Principal } from "~/auth/principal.ts";
import { getProjectById, getProjectBySlug } from "~/db/queries/.generated/index.ts";

export const ITX_PREFIX = "/api/itx";

export async function handleItxFetch(input: {
  config: AppConfig;
  context: AppContext;
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

  // Bare prefix → global handle; anything else is a project id or slug.
  let props: ItxProps;
  if (subpath === "") {
    props = { access, context: GLOBAL_CONTEXT_ID };
  } else {
    const projectId = await resolveAccessibleProjectId({
      access,
      context: input.context,
      projectIdOrSlug: decodeURIComponent(subpath),
    });
    if (!projectId) return new Response("Not Found", { status: 404 });
    props = { context: projectId };
  }

  const response = await newWorkersRpcResponse(
    input.request,
    resolveItx({ env: input.env, exports: workerExports(input.context), props }),
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
    resolveItx({
      env: input.env,
      exports: input.exports as ItxRuntime["exports"],
      props: { context: input.projectId },
    }),
  );
}

async function authenticateItxRequest(input: {
  config: AppConfig;
  context: AppContext;
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

/** The simplified access model: admin sees all, users see their projects. */
function accessForPrincipal(principal: Principal): ProjectAccess {
  return principal.type === "admin" ? "all" : principal.projects.map((project) => project.id);
}

async function resolveAccessibleProjectId(input: {
  access: ProjectAccess;
  context: AppContext;
  projectIdOrSlug: string;
}): Promise<string | null> {
  const row = input.projectIdOrSlug.startsWith("proj_")
    ? await getProjectById(input.context.db, { id: input.projectIdOrSlug })
    : await getProjectBySlug(input.context.db, { slug: input.projectIdOrSlug });
  if (!row) return null;
  if (input.access !== "all" && !input.access.includes(row.id)) return null;
  return row.id;
}

// ---- /api/itx/run ----------------------------------------------------------
//
// The dumb harness: load a one-off isolate whose env.ITERATE is an
// ItxEntrypoint, call the provided function with { itx, vars }, JSON the
// result. No fetch monkeypatching — when the script runs against a project
// context, bare fetch() IS project egress via globalOutbound (Law 5).

function itxRunWorkerSource(functionSource: string) {
  return /* js */ `
    import { WorkerEntrypoint } from "cloudflare:workers";

    const script = (${functionSource});

    export default class extends WorkerEntrypoint {
      async run(vars) {
        try {
          const itx = await this.env.ITERATE.context;
          const result = await script({ itx, vars });
          return JSON.stringify({ ok: true, result });
        } catch (error) {
          return JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            ok: false,
            stack: error instanceof Error ? error.stack : undefined,
          });
        }
      }
    }
  `;
}

async function handleItxRun(input: {
  access: ProjectAccess;
  context: AppContext;
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
  if (body.context && body.context !== GLOBAL_CONTEXT_ID) {
    const projectId = await resolveAccessibleProjectId({
      access: input.access,
      context: input.context,
      projectIdOrSlug: body.context,
    });
    if (!projectId) return Response.json({ error: "Context not found" }, { status: 404 });
    props = { context: projectId };
  } else {
    props = { access: input.access, context: GLOBAL_CONTEXT_ID };
  }

  const exports = workerExports(input.context) as Record<
    string,
    (options: { props: Record<string, unknown> }) => unknown
  >;
  const worker = input.env.LOADER.load({
    compatibilityDate: "2026-04-27",
    env: {
      ITERATE: exports.ItxEntrypoint!({ props }),
    },
    // Project scripts get the egress pipe as their global fetch; global
    // scripts inherit the parent's network (they are admin-held by
    // construction — only connect-time auth mints global handles).
    ...(props.context !== GLOBAL_CONTEXT_ID
      ? {
          globalOutbound: exports.ProjectEgress!({
            props: { context: props.context, project: props.context },
          }) as Fetcher,
        }
      : {}),
    mainModule: "itx-script.js",
    modules: { "itx-script.js": itxRunWorkerSource(body.functionSource) },
  });

  const entrypoint = worker.getEntrypoint() as unknown as {
    run(vars: Record<string, unknown>): Promise<string>;
  } & Partial<Disposable>;
  try {
    const outcome = JSON.parse(await entrypoint.run(body.vars ?? {})) as
      | { ok: true; result: unknown }
      | { error: string; ok: false; stack?: string };
    if (!outcome.ok) {
      return Response.json({ error: outcome.error, stack: outcome.stack }, { status: 500 });
    }
    return Response.json({ result: outcome.result ?? null });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      { status: 500 },
    );
  } finally {
    entrypoint[Symbol.dispose]?.();
  }
}

function workerExports(context: AppContext): ItxRuntime["exports"] {
  if (!context.workerExports) {
    throw new Error("Worker exports are not available on this AppContext.");
  }
  return context.workerExports as unknown as ItxRuntime["exports"];
}
