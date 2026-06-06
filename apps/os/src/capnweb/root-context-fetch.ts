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
  import {
    callLocalProxyCaller,
    isLocalProxyCaller,
    liftLocalProxies,
    localProxyCaller,
  } from "./local-proxy-wrapper.js";

  const snippet = (${input.functionSource});
  const props = ${JSON.stringify(input.props)};
  const mountModules = new Map();
  ${mountImports}

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

  function isPathPrefix(prefix, path) {
    return prefix.every((segment, index) => path[index] === segment);
  }

  function dynamicMountForPath(path) {
    let match;
    for (const mount of props.mounts ?? []) {
      if (mount.target.type !== "dynamic-worker") continue;
      if (!isPathPrefix(mount.path, path)) continue;
      if (!match || mount.path.length > match.path.length) match = mount;
    }
    return match;
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

  function resolveTargetCall(target, call) {
    let current = target;
    for (const step of call) {
      if (current == null) throw new Error("Cannot resolve target call through " + String(current));
      if (typeof step === "string") {
        const parent = current;
        const value = parent[step];
        current = typeof value === "function" ? value.bind(parent) : value;
        continue;
      }
      const method = current[step.method];
      if (typeof method !== "function") throw new Error("Target method " + step.method + " is not callable.");
      current = method.apply(current, step.args ?? []);
    }
    return current;
  }

  async function invokeResolvedMountTarget(target, remainder, args, path) {
    if (isLocalProxyCaller(target)) {
      return await callLocalProxyCaller(target, { path: remainder, args });
    }
    const method = remainder.length > 0 ? resolveTargetCall(target, remainder) : target;
    if (typeof method !== "function") {
      throw new Error("Mounted path " + path.join(".") + " did not resolve to a function.");
    }
    return await method(...args);
  }

  function ctxWithLocalDynamicMounts(host, ctx) {
    const lifted = liftLocalProxies(ctx);
    return new Proxy(lifted, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && hasDynamicMountRoot(prop)) {
          // Dynamic worker entrypoints cannot be transferred from one dynamic
          // worker to another. The parent still owns the run worker, but /run
          // executes user dynamic mounts in this same isolate so snippets can
          // call ctx.tools.echo() and ctx.sdk.chat.postMessage() normally.
          return liftLocalProxies(
            localProxyCaller(({ path, args }) => host.callDynamicMount([prop, ...path], args)),
          );
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
      const resolvedTarget = resolveTargetCall(target, mount.target.call ?? []);
      return await invokeResolvedMountTarget(resolvedTarget, remainder, args, path);
    }

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
      "local-proxy-wrapper.js": localProxyWrapperSource,
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
