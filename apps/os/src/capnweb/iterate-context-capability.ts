import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { createRequestLogger } from "@iterate-com/shared/request-logging";
import { createD1Client } from "sqlfu";
import {
  callLocalProxyCaller,
  isLocalProxyCaller,
  localProxyCaller,
} from "./local-proxy-wrapper.js";
import localProxyWrapperSource from "./local-proxy-wrapper.js?raw";
import type { ProjectCapability, ProjectWorkerCapability } from "./project-capability.ts";
import { ProjectsCapability } from "./projects-capability.ts";
import type { ProjectReposCapability } from "./repos-capability.ts";
import type { ProjectStreamsCapability } from "./streams-capability.ts";
import type { ProjectWorkspaceCapability } from "./workspace-capability.ts";
import manifest, { AppConfig } from "~/app.ts";
import type { AppContext } from "~/context.ts";

type RuntimeContext = Pick<ExecutionContext, "exports" | "waitUntil">;

export type ProjectScopes = {
  projects: "all" | string[];
};

export type IterateContextProps = {
  mounts?: Mount[];
  scopes: ProjectScopes;
};

export type Mount = {
  path: string[];
  invoke?: "target" | "method";
  target: MountTarget;
};

export type MountTarget =
  | {
      call?: TargetCall[];
      entrypoint?: string;
      loader?: { get: string };
      script: string;
      type: "dynamic-worker";
    }
  | {
      call?: TargetCall[];
      type: "ctx";
    };

export type TargetCall =
  | string
  | {
      args?: unknown[];
      method: string;
    };

export type IterateContextRuntime = {
  context: AppContext;
  projects?: ProjectsCapability;
  props: IterateContextProps;
};

export class IterateContextEntrypoint extends WorkerEntrypoint<Env, IterateContextProps> {
  get context() {
    const workerCtx = Reflect.get(this, "ctx") as unknown as ExecutionContext<IterateContextProps>;
    const appContext = createCapnwebAppContext({
      ctx: workerCtx,
      env: this.env,
      method: "CAPNWEB",
      path: "capnweb://iterate-context-entrypoint",
    });
    return createIterateContext({
      context: appContext,
      projects: createProjectsCapability({
        context: appContext,
        iterateContextProps: workerCtx.props,
      }),
      props: workerCtx.props,
    });
  }

  async callMounted(path: string[], args: unknown[] = []) {
    return await this.context.callMounted(path, args);
  }
}

export class IterateCapability extends RpcTarget {
  readonly #runtime: IterateContextRuntime;
  readonly #dynamicWorkerTargets = new Map<string, unknown>();
  #project?: ProjectCapability;

  constructor(runtime: IterateContextRuntime) {
    super();
    this.#runtime = runtime;
  }

  get projects(): ProjectsCapability {
    if (!this.#runtime.projects) {
      throw new Error("Projects capability is not available in this IterateContext.");
    }
    return this.#runtime.projects;
  }

  get project(): ProjectCapability {
    return (this.#project ??= this.projects.get(requireRuntimeProjectId(this.#runtime)));
  }

  get repos(): ProjectReposCapability {
    return this.project.repos;
  }

  get streams(): ProjectStreamsCapability {
    return this.project.streams;
  }

  get workspace(): ProjectWorkspaceCapability {
    return this.project.workspace;
  }

  get worker(): ProjectWorkerCapability {
    return this.project.worker;
  }

  resolveDynamicWorkerTarget(target: Extract<MountTarget, { type: "dynamic-worker" }>) {
    const cacheKey = JSON.stringify({
      entrypoint: target.entrypoint,
      loader: target.loader,
      script: target.script,
    });
    const cached = this.#dynamicWorkerTargets.get(cacheKey);
    if (cached) return cached;

    const loader = this.#runtime.context.loader;
    if (!loader) throw new Error("LOADER binding is not available.");

    const iterateEntrypoint = this.#runtime.context.workerExports?.IterateContextEntrypoint as
      | ((options: { props: IterateContextProps }) => unknown)
      | undefined;
    if (!iterateEntrypoint) {
      throw new Error("IterateContextEntrypoint export is not available.");
    }

    const workerCode = {
      compatibilityDate: "2026-04-27",
      env: {
        ITERATE: iterateEntrypoint({ props: { scopes: this.#runtime.props.scopes } }),
      },
      mainModule: "mount-worker.js",
      modules: {
        "local-proxy-wrapper.js": localProxyWrapperSource,
        "mount-worker.js": target.script,
      },
    };
    const worker =
      target.loader && typeof target.loader === "object"
        ? loader.get(target.loader.get, () => workerCode)
        : loader.load(workerCode);
    const entrypoint =
      target.entrypoint != null ? worker.getEntrypoint(target.entrypoint) : worker.getEntrypoint();
    this.#dynamicWorkerTargets.set(cacheKey, entrypoint);
    return entrypoint;
  }
}

export class IterateContext extends IterateCapability {
  readonly #mounts: Mount[];

  constructor(input: IterateContextRuntime) {
    super(input);
    this.#mounts = input.props.mounts ?? [];
    installMountedRootMembers(this, this.#mounts);
  }

  async callMounted(path: string[], args: unknown[] = []) {
    const match = resolveMount(this.#mounts, path);
    if (!match) {
      throw new Error(`No mount registered for ${path.join(".")}`);
    }

    if (match.mount.target.type === "dynamic-worker") {
      try {
        return await this.invokeDynamicWorkerMount({
          args,
          remainder: match.remainder,
          target: match.mount.target,
        });
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        throw new Error(`Dynamic worker mount ${path.join(".")} failed: ${cause}`, {
          cause: error,
        });
      }
    }

    return await invokeResolvedMountTarget({
      args,
      path,
      remainder: match.remainder,
      target: await this.resolveMountTarget(match.mount.target),
    });
  }

  getMounted(path: string[]) {
    const match = this.requireMount(path);
    if (match.mount.target.type === "dynamic-worker") {
      return mountedPathCaller(this, path);
    }
    const resolved = {
      ...match,
      target: this.resolveMountTarget(match.mount.target),
    };
    if (resolved.remainder.length === 0) return resolved.target;
    return resolveTargetCall(resolved.target, resolved.remainder);
  }

  private requireMount(path: string[]) {
    const match = resolveMount(this.#mounts, path);
    if (!match) {
      throw new Error(`No mount registered for ${path.join(".")}`);
    }
    return match;
  }

  private async resolveMountTarget(target: Mount["target"]): Promise<unknown> {
    switch (target.type) {
      case "dynamic-worker":
        throw new Error("Dynamic-worker mounts must be invoked through callMounted.");
      case "ctx":
        return await resolveTargetCall(this, target.call ?? []);
    }
  }

  resolveDynamicWorkerTarget(target: Extract<MountTarget, { type: "dynamic-worker" }>) {
    return super.resolveDynamicWorkerTarget(target);
  }

  private async invokeDynamicWorkerMount(input: {
    args: unknown[];
    remainder: string[];
    target: Extract<MountTarget, { type: "dynamic-worker" }>;
  }) {
    return await invokeDynamicWorkerTarget({
      args: input.args,
      call: input.target.call ?? [],
      path: input.remainder,
      target: this.resolveDynamicWorkerTarget(input.target),
    });
  }
}

export function createIterateContext(input: IterateContextRuntime) {
  return new IterateContext(input);
}

export function createProjectsCapability(input: {
  context: AppContext;
  iterateContextProps?: IterateContextProps;
}) {
  return new ProjectsCapability({
    activeOrganization: {
      isAdminApi: true,
      orgId: "root-context",
      orgPermissions: [],
      orgRole: "root",
      orgSlug: "root-context",
      sessionId: "root-context",
      userId: "root-context",
    },
    context: input.context,
    iterateContextProps: input.iterateContextProps,
  });
}

export function createCapnwebAppContext(input: {
  ctx: RuntimeContext;
  env: Env;
  method?: string;
  path?: string;
}): AppContext {
  const config = parseAppConfigFromEnv({
    configSchema: AppConfig,
    prefix: "APP_CONFIG_",
    env: input.env as unknown as Record<string, unknown>,
  });

  return {
    manifest,
    config,
    db: createD1Client(input.env.DB),
    doCatalog: input.env.DO_CATALOG ?? input.env.DB,
    log: createRequestLogger({
      method: input.method ?? "CAPNWEB",
      path: input.path ?? "capnweb://runtime",
      requestId: crypto.randomUUID(),
    }),
    projectHostnameBases: config.projectHostnameBases,
    waitUntil: (promise) => input.ctx.waitUntil(promise),
    agent: input.env.AGENT,
    callableEnv: input.env as unknown as Record<string, unknown>,
    codemodeSession: input.env.CODEMODE_SESSION,
    loader: input.env.LOADER,
    projectDurableObjectNamespace: input.env.PROJECT,
    repo: input.env.REPO,
    slackAgent: input.env.SLACK_AGENT,
    slackIntegration: input.env.SLACK_INTEGRATION,
    stream: input.env.STREAM,
    workerExports: input.ctx.exports,
  };
}

function mountedPathCaller(context: IterateContext, path: string[]) {
  return localProxyCaller(async (input) => {
    return await context.callMounted([...path, ...input.path], input.args);
  });
}

function installMountedRootMembers(context: IterateContext, mounts: Mount[]) {
  const rootNames = [
    ...new Set(mounts.map((mount) => mount.path[0]).filter((name) => name != null)),
  ];
  if (rootNames.length === 0) return;

  const basePrototype = Object.getPrototypeOf(context) as object;
  const prototype = Object.create(basePrototype) as object;

  for (const rootName of rootNames) {
    if (rootName in basePrototype) continue;
    const rootMount = mounts.find((mount) => mount.path.length === 1 && mount.path[0] === rootName);
    const invoke = rootMount?.invoke ?? "target";

    if (invoke === "method") {
      // Both Cap'n Web and Workers RPC expose prototype methods, not own
      // instance properties. User-defined method mounts therefore live on a
      // per-instance prototype object so this context exposes them without
      // mutating the shared IterateContext class.
      Object.defineProperty(prototype, rootName, {
        configurable: true,
        value: async function mountedMethod(this: IterateContext, ...args: unknown[]) {
          return await this.callMounted([rootName], args);
        },
        writable: false,
      });
      continue;
    }

    // Target mounts are prototype getters on this one context instance. Different
    // IterateContext instances can therefore expose different mounted roots
    // without leaking names or mount definitions.
    Object.defineProperty(prototype, rootName, {
      configurable: true,
      get(this: IterateContext) {
        if (rootMount) return this.getMounted(rootMount.path);
        return mountedPathCaller(this, [rootName]);
      },
    });
  }

  Object.setPrototypeOf(context, prototype);
}

function resolveMount(mounts: Mount[], path: string[]) {
  let mount: Mount | undefined;
  for (const candidate of mounts) {
    if (!isPathPrefix(candidate.path, path)) continue;
    if (!mount || candidate.path.length > mount.path.length) {
      mount = candidate;
    }
  }
  if (!mount) return null;
  return {
    mount,
    remainder: path.slice(mount.path.length),
  };
}

function isPathPrefix(prefix: string[], path: string[]) {
  return prefix.every((segment, index) => path[index] === segment);
}

async function resolveTargetCall(target: unknown, call: readonly TargetCall[]): Promise<unknown> {
  let current = target;
  for (const step of call) {
    current = await current;
    if (current == null) {
      throw new Error(`Cannot resolve target call through ${String(current)}.`);
    }

    if (typeof step === "string") {
      const parent = current;
      const value = (parent as Record<string, unknown>)[step];
      current =
        typeof value === "function" && typeof value.bind === "function"
          ? value.bind(parent)
          : value;
      continue;
    }

    const method = (current as Record<string, unknown>)[step.method];
    if (typeof method !== "function") {
      throw new Error(`Target method ${step.method} is not callable.`);
    }
    current = Reflect.apply(method, current, step.args ?? []);
  }
  return await current;
}

async function invokeResolvedMountTarget(input: {
  args: unknown[];
  path: string[];
  remainder: string[];
  target: unknown;
}) {
  if (isLocalProxyCaller(input.target)) {
    return await callLocalProxyCaller(input.target, {
      args: input.args,
      path: input.remainder,
    });
  }

  const method =
    input.remainder.length > 0
      ? await resolveTargetCall(input.target, input.remainder)
      : input.target;
  if (typeof method !== "function") {
    throw new Error(`Mounted path ${input.path.join(".")} did not resolve to a function.`);
  }
  return await method(...input.args);
}

async function invokeDynamicWorkerTarget(input: {
  args: unknown[];
  call: readonly TargetCall[];
  path: string[];
  target: unknown;
}) {
  const lastCallStep = input.call.at(-1);
  if (input.path.length === 0 && typeof lastCallStep === "string") {
    // A method mount like target.call=["echo"] must preserve method-call
    // syntax. Pulling echo off the dynamic-worker entrypoint and binding it can
    // make workerd try to transfer the entrypoint; calling parent.echo(...)
    // keeps the entrypoint private to the parent Worker and preserves `this`.
    const parent = (await resolveDynamicTargetCall(input.target, input.call.slice(0, -1)))
      .value as Record<string, (...args: unknown[]) => unknown>;
    if (typeof parent[lastCallStep] !== "function") {
      throw new Error(`Dynamic target method ${lastCallStep} is not callable.`);
    }
    return await parent[lastCallStep](...input.args);
  }

  const resolved = await resolveDynamicTargetCall(input.target, input.call);
  let current = resolved.value;

  if (isLocalProxyCaller(current)) {
    return await callLocalProxyCaller(current, {
      args: input.args,
      path: input.path,
    });
  }

  if (input.path.length === 0) {
    if (typeof current !== "function") {
      throw new Error("Dynamic worker mount did not resolve to a callable target.");
    }
    return await Reflect.apply(current, resolved.receiver, input.args);
  }

  for (const segment of input.path.slice(0, -1)) {
    // Nested dynamic-worker getters like tools.nested return RPC promises.
    // Await them in the parent before walking deeper so the final result is
    // serializable back to the /run worker.
    current = await (current as Record<string, unknown>)[segment];
  }

  const methodName = input.path.at(-1)!;
  const method = (current as Record<string, unknown>)[methodName];
  if (typeof method !== "function") {
    throw new Error(`Dynamic worker mount ${input.path.join(".")} did not resolve to a function.`);
  }
  return await Reflect.apply(method, current, input.args);
}

async function resolveDynamicTargetCall(
  target: unknown,
  call: readonly TargetCall[],
): Promise<{ receiver: unknown; value: unknown }> {
  let current = target;
  let receiver: unknown;
  for (const step of call) {
    current = await current;
    if (current == null) {
      throw new Error(`Cannot resolve dynamic target call through ${String(current)}.`);
    }

    if (typeof step === "string") {
      const parent = current;
      const value = (parent as Record<string, unknown>)[step];
      receiver = parent;
      current = value;
      continue;
    }

    const parent = current;
    const method = (current as Record<string, unknown>)[step.method];
    if (typeof method !== "function") {
      throw new Error(`Dynamic target method ${step.method} is not callable.`);
    }
    receiver = undefined;
    current = Reflect.apply(method, parent, step.args ?? []);
  }
  return { receiver, value: await current };
}

export function singleProjectIdFromScopes(scopes: ProjectScopes): string | null {
  return Array.isArray(scopes.projects) && scopes.projects.length === 1
    ? scopes.projects[0]!
    : null;
}

function requireRuntimeProjectId(runtime: IterateContextRuntime) {
  const projectId = singleProjectIdFromScopes(runtime.props.scopes);
  if (!projectId) {
    throw new Error("This capability requires an IterateContext scoped to exactly one project.");
  }
  return projectId;
}
