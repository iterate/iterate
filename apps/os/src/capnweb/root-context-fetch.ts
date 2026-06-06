import { newWorkersRpcResponse } from "capnweb";
import {
  createIterateContext,
  createProjectsCapability,
  type IterateContextProps,
} from "./iterate-context-capability.ts";
import localProxyWrapperSource from "./local-proxy-wrapper.js?raw";
import { ProjectsCapability } from "./projects-capability.ts";
import type { AppConfig } from "~/app.ts";
import { authenticateRootApiSecret } from "~/auth/middleware.ts";
import type { AppContext } from "~/context.ts";

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

  const principal = authenticateRootApiSecret({ config: input.config }, input.request);
  if (!principal) return new Response("Unauthorized", { status: 401 });

  if (url.pathname === `${ROOT_ITERATE_CONTEXT_PREFIX}/run`) {
    return await handleRootRunLeg(input);
  }

  return newWorkersRpcResponse(
    input.request,
    createIterateContext({
      context: input.context,
      projects: createProjectsCapability({ context: input.context }),
      props: { scopes: { projects: "all" } },
    }),
  );
}

function rootRunWorkerSrc(input: { dynamicMountRoots: string[]; functionSource: string }) {
  return /* js */ `
  import { WorkerEntrypoint } from "cloudflare:workers";
  import { __callDispose, __using, liftLocalProxies, localProxyCaller } from "./local-proxy-wrapper.js";

  const snippet = (${input.functionSource});
  const dynamicMountRoots = new Set(${JSON.stringify(input.dynamicMountRoots)});

  function contextForRun(host, ctx) {
    const lifted = liftLocalProxies(ctx);
    if (dynamicMountRoots.size === 0) return lifted;
    // This Proxy is a narrow /run compatibility overlay, not the canonical
    // context object. The /run worker gets ctx from env.ITERATE.context so
    // built-in roots like ctx.projects and ctx.project are the normal
    // parent-provided RPC stubs. Dynamic-worker mounts are different: their
    // actual WorkerEntrypoint is owned by the parent worker with the LOADER
    // binding and cannot be transferred into this /run worker. For just those
    // root names, this proxy returns a local SDK-style marker that forwards the
    // eventual call back to the parent-owned env.ITERATE.callMounted(...).
    //
    // Effect:
    //   ctx.tools.echo(arg)
    // becomes:
    //   env.ITERATE.callMounted(["tools", "echo"], [arg])
    //
    // Normal properties fall through untouched. This keeps the symmetric
    // snippet model ("const ctx = await env.ITERATE.context") while preserving
    // the dynamic-worker mount rule that the loader owner forwards the call.
    //
    // References:
    // - Dynamic Workers API: https://developers.cloudflare.com/dynamic-workers/api-reference/
    // - Workers RPC stubs: https://developers.cloudflare.com/workers/runtime-apis/rpc/
    return new Proxy(lifted, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && dynamicMountRoots.has(prop)) {
          return liftLocalProxies(localProxyCaller(({ path, args }) =>
            host.env.ITERATE.callMounted([prop, ...path], args)
          ));
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  export default class extends WorkerEntrypoint {
    async run(vars) {
      try {
        const ctx = contextForRun(this, await this.env.ITERATE.context);
        const result = await snippet({
          ctx,
          env: this.env,
          vars,
        });
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
  const props = body.props ?? { scopes: { projects: "all" } };
  const dynamicMountRoots = [
    ...new Set(
      (props.mounts ?? [])
        .filter((mount) => mount.target.type === "dynamic-worker")
        .map((mount) => mount.path[0])
        .filter((root): root is string => root != null),
    ),
  ];
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
        dynamicMountRoots,
        functionSource: body.functionSource,
      }),
      "local-proxy-wrapper.js": localProxyWrapperSource,
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
