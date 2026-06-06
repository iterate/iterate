import { newWorkersRpcResponse } from "capnweb";
import {
  createIterateContext,
  createProjectsCapability,
  type IterateContextProps,
} from "./iterate-context-capability.ts";
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

function rootRunWorkerSrc(input: {
  functionSource: string;
  moduleByTargetKey: Record<string, string>;
  props: IterateContextProps;
}) {
  const mountImports = Object.entries(input.moduleByTargetKey)
    .map(([targetKey, moduleName], index) => {
      return `import * as mountModule${index} from ${JSON.stringify(`./${moduleName}`)};
mountModules.set(${JSON.stringify(targetKey)}, mountModule${index});`;
    })
    .join("\n");

  return /* js */ `
  import { WorkerEntrypoint } from "cloudflare:workers";
  const snippet = (${input.functionSource});
  const props = ${JSON.stringify(input.props)};
  const LOCAL_PATH_CALLER_MARK = "__localProxyCaller";
  const mountModules = new Map();
  ${mountImports}

  function isPathPrefix(prefix, path) {
    return prefix.every((segment, index) => path[index] === segment);
  }

  function dynamicMountForPath(path) {
    return (props.mounts ?? [])
      .filter((mount) => mount.target.type === "dynamic-worker" && isPathPrefix(mount.path, path))
      .sort((left, right) => right.path.length - left.path.length)[0];
  }

  function hasDynamicMountRoot(rootName) {
    return (props.mounts ?? []).some(
      (mount) => mount.target.type === "dynamic-worker" && mount.path[0] === rootName,
    );
  }

  function targetKey(target) {
    return JSON.stringify({
      entrypoint: target.entrypoint,
      loader: target.loader,
      script: target.script,
    });
  }

  function localTargetFromModule(module, target, env) {
    const exported = target.entrypoint != null ? module[target.entrypoint] : module.default;
    if (typeof exported === "function") {
      const instance = Object.create(exported.prototype);
      Object.defineProperty(instance, "env", { value: env });
      return instance;
    }
    return exported;
  }

  async function invokeTargetCall(target, call, args) {
    let current = target;
    for (let index = 0; index < call.length; index++) {
      const step = call[index];
      const isLast = index === call.length - 1;
      if (typeof step === "string") {
        const value = current[step];
        if (isLast) return await value.apply(current, args);
        current = value;
        continue;
      }
      const result = current[step.method].apply(current, step.args ?? []);
      if (isLast) return args.length > 0 ? await result(...args) : await result;
      current = result;
    }
    return await current(...args);
  }

  function pathProxy(call, path = []) {
    const fn = (...args) => call(path, args);
    return new Proxy(fn, {
      get(target, prop, receiver) {
        if (typeof prop === "symbol" || prop in target) {
          return Reflect.get(target, prop, receiver);
        }
        if (prop === "then") return undefined;
        return pathProxy(call, [...path, prop]);
      },
    });
  }

  function adapt(value) {
    if (
      value &&
      typeof value === "object" &&
      value[LOCAL_PATH_CALLER_MARK] === true &&
      value.call
    ) {
      return pathProxy((path, args) => value.call.call({ path, args }));
    }
    return value;
  }

  function lift(value) {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) {
      return value;
    }
    return new Proxy(value, {
      get(target, prop, receiver) {
        if (prop === "then" && typeof target.then === "function") {
          return (onFulfilled, onRejected) =>
            target.then((resolved) => onFulfilled(adapt(resolved)), onRejected);
        }
        const member = Reflect.get(target, prop, receiver);
        return lift(member);
      },
      apply(target, thisArg, args) {
        return lift(Reflect.apply(target, thisArg, args));
      },
    });
  }

  function ctxWithLocalDynamicMounts(host, ctx) {
    const lifted = lift(ctx);
    return new Proxy(lifted, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && hasDynamicMountRoot(prop)) {
          // A dynamic /run worker cannot call back to the parent and have the
          // parent call a second dynamic worker. Keep user mounts in-process.
          return pathProxy((path, args) => host.callDynamicMount(path, args), [prop]);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  export default class extends WorkerEntrypoint {
    localTargets = new Map();

    localDynamicWorkerTarget(target) {
      const key = targetKey(target);
      const cached = this.localTargets.get(key);
      if (cached) return cached;
      const module = mountModules.get(key);
      if (!module) throw new Error("No local mount module for dynamic worker target.");
      const localTarget = localTargetFromModule(module, target, this.env);
      this.localTargets.set(key, localTarget);
      return localTarget;
    }

    async callDynamicMount(path, args) {
      const mount = dynamicMountForPath(path);
      if (!mount) throw new Error("No dynamic worker mount registered for " + path.join("."));
      const remainder = path.slice(mount.path.length);
      const target = this.localDynamicWorkerTarget(mount.target);
      if (mount.invoke === "catchall") {
        return await invokeTargetCall(target, mount.target.call ?? [], [{ path: remainder, args }]);
      }
      return await invokeTargetCall(target, [...(mount.target.call ?? []), ...remainder], args);
    }

    async run({ ctx, vars }) {
      try {
        const result = await snippet({ ctx: ctxWithLocalDynamicMounts(this, ctx), env: this.env, vars });
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
  const mountModules = dynamicWorkerMountModules(props);
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
        moduleByTargetKey: mountModules.moduleByTargetKey,
        props,
      }),
      ...mountModules.modules,
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

function dynamicWorkerMountModules(props: IterateContextProps) {
  const modules: Record<string, string> = {};
  const moduleByTargetKey: Record<string, string> = {};
  for (const mount of props.mounts ?? []) {
    if (mount.target.type !== "dynamic-worker") continue;
    const key = JSON.stringify({
      entrypoint: mount.target.entrypoint,
      loader: mount.target.loader,
      script: mount.target.script,
    });
    if (moduleByTargetKey[key]) continue;
    const moduleName = `mount-${Object.keys(moduleByTargetKey).length}.js`;
    moduleByTargetKey[key] = moduleName;
    modules[moduleName] = mount.target.script;
  }
  return { moduleByTargetKey, modules };
}
