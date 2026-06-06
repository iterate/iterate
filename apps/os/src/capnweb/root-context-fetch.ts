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

function rootRunWorkerSrc(input: { functionSource: string; props: IterateContextProps }) {
  return /* js */ `
  import { WorkerEntrypoint } from "cloudflare:workers";
  import {
    liftLocalProxies,
    localProxyCaller,
  } from "./local-proxy-wrapper.js";

  const snippet = (${input.functionSource});
  const props = ${JSON.stringify(input.props)};

  function __using(stack, value, isAsync) {
    if (value == null) return value;
    const dispose =
      isAsync && Symbol.asyncDispose && value[Symbol.asyncDispose]
        ? value[Symbol.asyncDispose]
        : value[Symbol.dispose];
    if (typeof dispose !== "function") {
      throw new TypeError("Object is not disposable.");
    }
    stack.push({ async: Boolean(isAsync), dispose, value });
    return value;
  }

  function __callDispose(stack, error, hasError) {
    let promise;
    const rememberError = (disposeError) => {
      if (hasError) {
        error =
          typeof SuppressedError === "function"
            ? new SuppressedError(disposeError, error, "An error was suppressed during disposal.")
            : disposeError;
      } else {
        error = disposeError;
        hasError = true;
      }
    };
    const disposeSync = (entry) => {
      try {
        entry.dispose.call(entry.value);
      } catch (disposeError) {
        rememberError(disposeError);
      }
    };
    const disposeAsync = async (entry) => {
      try {
        await entry.dispose.call(entry.value);
      } catch (disposeError) {
        rememberError(disposeError);
      }
    };

    while (stack.length > 0) {
      const entry = stack.pop();
      if (promise || entry.async) {
        promise = Promise.resolve(promise).then(() => disposeAsync(entry));
      } else {
        disposeSync(entry);
      }
    }

    if (promise) {
      return promise.then(() => {
        if (hasError) throw error;
      });
    }
    if (hasError) throw error;
  }

  function hasDynamicMountRoot(rootName) {
    return (props.mounts ?? []).some(
      (mount) => mount.target.type === "dynamic-worker" && mount.path[0] === rootName,
    );
  }

  function ctxWithLocalDynamicMounts(host, ctx) {
    const lifted = liftLocalProxies(ctx);
    return new Proxy(lifted, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && hasDynamicMountRoot(prop)) {
          // Built-in roots can travel as the injected ctx object. Dynamic-worker
          // mounts cannot expose their entrypoint to this run worker, so the
          // local proxy records the rest of the JavaScript path and asks the
          // parent-owned ITERATE binding to forward the final call.
          return liftLocalProxies(
            localProxyCaller(({ path, args }) =>
              host.env.ITERATE.callMounted([prop, ...path], args),
            ),
          );
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  export default class extends WorkerEntrypoint {
    async run({ ctx, vars }) {
      try {
        const result = await snippet({
          ctx: ctxWithLocalDynamicMounts(this, ctx),
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
  const context = createIterateContext({
    context: input.context,
    projects: createProjectsCapability({ context: input.context }),
    props,
  });
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
        props,
      }),
      "local-proxy-wrapper.js": localProxyWrapperSource,
    },
  });
  const entry = worker.getEntrypoint() as unknown as {
    run(input: {
      ctx: ReturnType<typeof createIterateContext>;
      vars: CaptnwebVars;
    }): string | Promise<string>;
  } & Partial<Disposable>;
  try {
    const json = await entry.run({
      ctx: context,
      vars: body.vars ?? {},
    });
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
