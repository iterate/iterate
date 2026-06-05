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
  const mountModules = new Map();
  ${mountImports}
  function isPathPrefix(prefix, path) {
    return prefix.every((segment, index) => path[index] === segment);
  }
  function resolveMount(path) {
    return (props.mounts ?? [])
      .filter((mount) => isPathPrefix(mount.path, path))
      .sort((left, right) => right.path.length - left.path.length)[0];
  }
  function targetKey(target) {
    return JSON.stringify({
      entrypoint: target.entrypoint,
      loader: target.loader,
      script: target.script,
    });
  }
  function localTargetFromModule(module, target, env) {
    const exported =
      target.entrypoint != null ? module[target.entrypoint] : module.default;
    if (typeof exported === "function") {
      const instance = Object.create(exported.prototype);
      // WorkerEntrypoint instances normally receive env from workerd. For /run
      // mount modules we invoke the target in-process, so install the same env
      // shape explicitly and keep the target entrypoint private to this worker.
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
  function pathFromExpression(expression) {
    return expression.map((step) => (typeof step === "string" ? step : step.method));
  }
  function expressionSuffixFromPath(expression, prefixLength) {
    const suffix = [];
    let consumed = 0;
    for (const step of expression) {
      if (consumed < prefixLength) {
        consumed++;
        continue;
      }
      suffix.push(step);
    }
    return suffix;
  }
  function finalCallArgs(expression) {
    const last = expression[expression.length - 1];
    return last && typeof last !== "string" ? last.args ?? [] : [];
  }
  function isTargetReturningExpression(expression) {
    const path = pathFromExpression(expression);
    return path[path.length - 1] === "get";
  }
  function createCtxProxy(host, expression = []) {
    const fn = (...args) => {
      if (expression.length === 0) {
        return host.callExpression([{ method: "call", args }]);
      }
      const last = expression[expression.length - 1];
      const nextExpression =
        typeof last === "string"
          ? [...expression.slice(0, -1), { method: last, args }]
          : [...expression, { method: "call", args }];
      if (isTargetReturningExpression(nextExpression)) {
        return createCtxProxy(host, nextExpression);
      }
      return host.callExpression(nextExpression);
    };
    return new Proxy(fn, {
      get(target, prop, receiver) {
        if (typeof prop === "symbol" || prop in target) {
          return Reflect.get(target, prop, receiver);
        }
        if (prop === "then") return undefined;
        return createCtxProxy(host, [...expression, prop]);
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

    async callExpression(expression) {
      try {
        const path = pathFromExpression(expression);
        const mount = resolveMount(path);
        if (mount?.target.type === "dynamic-worker") {
          const remainder = path.slice(mount.path.length);
          const remainderExpression = expressionSuffixFromPath(expression, mount.path.length);
          const target = this.localDynamicWorkerTarget(mount.target);
          if (mount.invoke === "catchall") {
            return await invokeTargetCall(target, mount.target.call ?? [], [
              { path: remainder, args: finalCallArgs(expression) },
            ]);
          }
          const call = [...(mount.target.call ?? []), ...remainderExpression];
          return await invokeTargetCall(
            target,
            call,
            remainderExpression.length === 0 ? finalCallArgs(expression) : [],
          );
        }
        return await this.env.ITERATE.callContext(expression);
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        throw new Error("Mounted call " + pathFromExpression(expression).join(".") + " failed: " + cause, {
          cause: error,
        });
      }
    }

    async run({ vars }) {
      try {
        const result = await snippet({ ctx: createCtxProxy(this), env: this.env, vars });
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
    run(input: { vars: CaptnwebVars }): string | Promise<string>;
  } & Partial<Disposable>;
  try {
    const json = await entry.run({
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
