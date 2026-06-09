import { newWorkersRpcResponse } from "capnweb";
import { authenticateCapnwebAdmin, handleCapnwebAdminCookieRequest } from "./admin-auth-cookie.ts";
import {
  createIterateContext,
  createProjectsCapability,
  type IterateContextProps,
} from "./iterate-context-capability.ts";
import { ProjectsCapability } from "./projects-capability.ts";
import type { AppConfig } from "~/app.ts";
import type { AppContext } from "~/context.ts";
import { createOsIterateAuth, resolveRequestAuth } from "~/auth/middleware.ts";
import type { Principal } from "~/auth/principal.ts";

export { ProjectsCapability };

export const ROOT_ITERATE_CONTEXT_PREFIX = "/api/captnweb";

type CaptnwebVars = Record<string, unknown>;

export async function handleRootIterateContextFetch(input: {
  config: AppConfig;
  context: AppContext;
  env: Env;
  request: Request;
}): Promise<Response | null> {
  const url = new URL(input.request.url);
  if (
    url.pathname !== ROOT_ITERATE_CONTEXT_PREFIX &&
    !url.pathname.startsWith(`${ROOT_ITERATE_CONTEXT_PREFIX}/`)
  ) {
    return null;
  }

  if (url.pathname === `${ROOT_ITERATE_CONTEXT_PREFIX}/admin-cookie`) {
    return await handleCapnwebAdminCookieRequest({ config: input.config, request: input.request });
  }

  const auth = await authenticateRootCapnwebRequest({
    config: input.config,
    context: input.context,
    request: input.request,
  });
  if (!auth.principal) return new Response("Unauthorized", { status: 401 });

  const context = {
    ...input.context,
    iterateAuthSession: auth.session,
    principal: auth.principal,
  };

  if (url.pathname === `${ROOT_ITERATE_CONTEXT_PREFIX}/run`) {
    return await handleRootRunLeg({ ...input, context });
  }

  const response = await newWorkersRpcResponse(
    input.request,
    createIterateContext({
      context,
      projects: createProjectsCapability({ context }),
      props: { scopes: scopesForPrincipal(auth.principal) },
    }),
  );
  appendAuthHeaders(response.headers, auth.responseHeaders);
  return response;
}

async function authenticateRootCapnwebRequest(input: {
  config: AppConfig;
  context: AppContext;
  request: Request;
}): Promise<{
  principal: Principal | null;
  responseHeaders: Headers;
  session: AppContext["iterateAuthSession"];
}> {
  const admin = authenticateCapnwebAdmin({ config: input.config, request: input.request });
  if (admin) return { principal: admin, responseHeaders: new Headers(), session: null };

  return await resolveRequestAuth({
    auth: createOsIterateAuth(input.context, input.request),
    context: input.context,
    request: input.request,
  });
}

function scopesForPrincipal(principal: Principal): IterateContextProps["scopes"] {
  return {
    projects: principal.type === "admin" ? "all" : principal.projects.map((project) => project.id),
  };
}

function appendAuthHeaders(headers: Headers, authHeaders: Headers) {
  const setCookie = authHeaders.get("set-cookie");
  if (setCookie) headers.append("set-cookie", setCookie);
}

function rootRunWorkerSrc(input: { functionSource: string }) {
  return /* js */ `
  import { WorkerEntrypoint } from "cloudflare:workers";

  const snippet = (${input.functionSource});

  async function projectEgressFetch(ctx, ...args) {
    return await ctx.project.egressFetch(new Request(args[0], args[1]));
  }

  async function runWithProjectEgressFetch(ctx, run) {
    // Dynamic Workers normally have a host-controlled outbound fetch gate. The
    // /run worker is our tiny codemode-shaped harness, so it installs the same
    // rule at the runner boundary: bare fetch() goes through the Project Durable
    // Object egress path, including getSecret(...) header substitution.
    //
    // This is intentionally scoped to the snippet invocation and restored in a
    // finally block. Built-in project ingress fetch remains available as
    // ctx.project.fetch(...); this hook is only the global outbound fetch.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (...args) => projectEgressFetch(ctx, ...args);
    try {
      return await run();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  export default class extends WorkerEntrypoint {
    async run(vars) {
      try {
        const ctx = await this.env.ITERATE.context;
        const result = await runWithProjectEgressFetch(ctx, () =>
          snippet({
            ctx,
            env: this.env,
            vars,
          })
        );
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

async function handleRootRunLeg(input: { context: AppContext; env: Env; request: Request }) {
  if (!input.env.LOADER) {
    return Response.json({ error: "LOADER binding not available" }, { status: 503 });
  }

  const body = (await input.request.json()) as {
    functionSource?: string;
    props?: IterateContextProps;
    vars?: CaptnwebVars;
  };
  if (typeof body.functionSource !== "string" || body.functionSource.trim() === "") {
    return Response.json({ error: "functionSource is required" }, { status: 400 });
  }
  const iterateEntrypoint = input.context.workerExports?.IterateContextEntrypoint as
    | ((options: { props: IterateContextProps }) => unknown)
    | undefined;
  if (!iterateEntrypoint) {
    return Response.json(
      { error: "IterateContextEntrypoint export is not available" },
      { status: 503 },
    );
  }
  const principal = input.context.principal;
  if (!principal) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const props = body.props ?? { scopes: scopesForPrincipal(principal) };
  const worker = input.env.LOADER.load({
    compatibilityDate: "2026-04-27",
    env: {
      ITERATE: iterateEntrypoint({
        props,
      }),
    },
    mainModule: "worker.js",
    modules: {
      "worker.js": rootRunWorkerSrc({
        functionSource: body.functionSource,
      }),
    },
  });
  const entry = worker.getEntrypoint() as unknown as {
    run(vars: CaptnwebVars): string | Promise<string>;
  } & Partial<Disposable>;
  try {
    const json = await entry.run(body.vars ?? {});
    const runResult = JSON.parse(json) as
      | { ok: true; result: unknown }
      | { error: string; ok: false; stack?: string };
    if (!runResult.ok) {
      return Response.json({ error: runResult.error, stack: runResult.stack }, { status: 500 });
    }
    return Response.json(runResult.result);
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      { status: 500 },
    );
  } finally {
    entry[Symbol.dispose]?.();
  }
}
