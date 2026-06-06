import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { createRequestLogger } from "@iterate-com/shared/request-logging";
import { createD1Client } from "sqlfu";
import { ProjectsCapability } from "./projects-capability.ts";
import manifest, { AppConfig } from "~/app.ts";
import type { AppContext } from "~/context.ts";
import type { ProjectCapabilityApi } from "~/domains/projects/durable-objects/project-durable-object.ts";
import {
  ensureIterateConfigInfoForProject,
  getReposCapability,
  type ReposCapability,
  type ReposCapabilityEnv,
} from "~/domains/repos/entrypoints/repo-capability.ts";
import {
  getStreamsCapability,
  type StreamsCapability,
} from "~/domains/streams/entrypoints/streams-capability.ts";
import type { WorkspaceCapability } from "~/domains/workspaces/entrypoints/workspace-capability.ts";

type RuntimeContext = Pick<ExecutionContext, "exports" | "waitUntil">;
const LOCAL_PATH_CALLER_MARK = "__localProxyCaller";

export type ProjectDurableObjectContextClient = {
  getCapability(props?: { scopes?: unknown }): ProjectCapabilityApi;
};

export type ProjectScopes = {
  projects: "all" | string[];
};

export type IterateContextProps = {
  mounts?: Mount[];
  scopes: ProjectScopes;
};

export type Mount = {
  path: string[];
  invoke?: "target" | "method" | "catchall";
  target: MountTarget;
};

export type MountTarget =
  | {
      call?: TargetCall[];
      entrypoint?: string;
      loader?: "load" | { get: string };
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

export type ProjectsCapabilityClient = {
  create(input: { id?: string; slug: string }): Promise<{
    customHostname: string | null;
    createdAt: string;
    id: string;
    ingressUrl: string;
    slug: string;
    updatedAt: string;
  }>;
  find(input: { id: string }): Promise<{
    customHostname: string | null;
    createdAt: string;
    id: string;
    ingressUrl: string;
    slug: string;
    updatedAt: string;
  }>;
  findBySlug(input: { slug: string }): Promise<{
    customHostname: string | null;
    createdAt: string;
    id: string;
    ingressUrl: string;
    slug: string;
    updatedAt: string;
  }>;
  get(projectId: string): ProjectContextCapability;
  list(input?: { limit?: number; offset?: number }): Promise<{
    projects: Array<{
      customHostname: string | null;
      createdAt: string;
      id: string;
      slug: string;
      updatedAt: string;
    }>;
    total: number;
  }>;
  remove(input: { id: string }): Promise<{ deleted: boolean; id: string; ok: true }>;
};

export type IterateContextRuntime = {
  context: AppContext;
  projects?: ProjectsCapabilityClient;
  props: IterateContextProps;
};

type IterateContextInput = {
  iterateCapability: IterateCapability;
  mounts?: Mount[];
};

type ReposClient = Pick<
  ReposCapability,
  "create" | "createInfo" | "ensureIterateConfigInfo" | "get" | "getInfo" | "list"
>;
type StreamsClient = Pick<
  StreamsCapability,
  "append" | "appendBatch" | "create" | "getState" | "list" | "listChildren" | "read"
>;
type WorkspaceClient = Pick<
  WorkspaceCapability,
  "gitAdd" | "gitClone" | "gitCommit" | "gitPush" | "gitStatus" | "readFile" | "writeFile"
>;

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
      }),
      props: workerCtx.props,
    });
  }
}

class IterateCapability extends RpcTarget {
  readonly #runtime: IterateContextRuntime;
  readonly #dynamicWorkerTargets = new Map<string, unknown>();

  constructor(runtime: IterateContextRuntime) {
    super();
    this.#runtime = runtime;
  }

  get projects(): ProjectsCapabilityClient {
    if (!this.#runtime.projects) {
      throw new Error("Projects capability is not available in this IterateContext.");
    }
    return this.#runtime.projects;
  }

  get project(): ProjectContextCapability {
    const projectId = this.requireSingleProjectId();
    return this.projects.get(projectId);
  }

  get repos(): ProjectReposCapability {
    return this.project.repos;
  }

  get streams(): ProjectStreamsCapability {
    return this.project.streams;
  }

  get worker(): ProjectWorkerCapability {
    return this.project.worker;
  }

  get workspace(): ProjectWorkspaceCapability {
    return this.project.workspace;
  }

  private requireSingleProjectId() {
    const scopedProjectId = singleProjectIdFromScopes(this.#runtime.props.scopes);
    const projectId = this.#runtime.projectId ?? scopedProjectId;
    if (!projectId) {
      throw new Error("This IterateCapability is not scoped to exactly one project.");
    }
    return projectId;
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

export class ProjectContextCapability extends RpcTarget {
  readonly #runtime: IterateContextRuntime;
  readonly #project: ProjectDurableObjectContextClient;
  readonly #projectId: string;
  #projectCapability?: ProjectCapabilityApi;
  #repos?: ProjectReposCapability;
  #streams?: ProjectStreamsCapability;
  #workspace?: ProjectWorkspaceCapability;
  #worker?: ProjectWorkerCapability;

  constructor(input: {
    project: ProjectDurableObjectContextClient;
    projectId: string;
    runtime: IterateContextRuntime;
  }) {
    super();
    this.#project = input.project;
    this.#projectId = input.projectId;
    this.#runtime = input.runtime;
  }

  get repos(): ProjectReposCapability {
    return (this.#repos ??= new ProjectReposCapability(this.#runtime));
  }

  get streams(): ProjectStreamsCapability {
    return (this.#streams ??= new ProjectStreamsCapability(this.#runtime));
  }

  get workspace(): ProjectWorkspaceCapability {
    return (this.#workspace ??= new ProjectWorkspaceCapability(this.#runtime));
  }

  get worker(): ProjectWorkerCapability {
    return (this.#worker ??= new ProjectWorkerCapability(this.projectCapability()));
  }

  async describe() {
    return await this.projectCapability().describe();
  }

  async fetch(request: Request) {
    return await this.projectCapability().fetch(request);
  }

  async getSummary() {
    return await this.projectCapability().getSummary();
  }

  async ingressFetch(request: Request) {
    return await this.projectCapability().ingressFetch(request);
  }

  async egressFetch(request: Request) {
    return await this.projectCapability().egressFetch(request);
  }

  async ingressUrl() {
    return await this.projectCapability().ingressUrl();
  }

  private projectCapability() {
    return (this.#projectCapability ??= this.#project.getCapability({
      scopes: { projectId: this.#projectId },
    }));
  }
}

export class IterateContext extends RpcTarget {
  readonly #iterateCapability: IterateCapability;
  readonly #mounts: Mount[];

  constructor(input: IterateContextInput) {
    super();
    this.#iterateCapability = input.iterateCapability;
    this.#mounts = input.mounts ?? [];
    installMountedRootMembers(this, this.#mounts);
  }

  get projects(): ProjectsCapabilityClient {
    return this.#iterateCapability.projects;
  }

  get project(): ProjectContextCapability {
    return this.#iterateCapability.project;
  }

  get repos(): ProjectReposCapability {
    return this.#iterateCapability.repos;
  }

  get streams(): ProjectStreamsCapability {
    return this.#iterateCapability.streams;
  }

  get worker(): ProjectWorkerCapability {
    return this.#iterateCapability.worker;
  }

  get workspace(): ProjectWorkspaceCapability {
    return this.#iterateCapability.workspace;
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
          invoke: match.mount.invoke ?? "target",
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

    const resolved = {
      ...match,
      target: this.resolveMountTarget(match.mount.target),
    };
    if (resolved.mount.invoke === "catchall") {
      if (typeof resolved.target !== "function") {
        throw new Error(
          `Catchall mount ${resolved.mount.path.join(".")} did not resolve to a function.`,
        );
      }
      return await resolved.target({ path: resolved.remainder, args });
    }

    if (resolved.remainder.length > 0) {
      const method = resolveTargetCall(resolved.target, resolved.remainder);
      if (typeof method !== "function") {
        throw new Error(`Mounted path ${path.join(".")} did not resolve to a function.`);
      }
      return await method(...args);
    }

    if (typeof resolved.target !== "function") {
      throw new Error(`Mounted path ${path.join(".")} did not resolve to a function.`);
    }
    return await resolved.target(...args);
  }

  getMounted(path: string[]) {
    const match = this.requireMount(path);
    if (match.mount.target.type === "dynamic-worker") {
      return localPathCaller(new MountedPathCaller(this, path));
    }
    const resolved = {
      ...match,
      target: this.resolveMountTarget(match.mount.target),
    };
    if (resolved.mount.invoke === "catchall") {
      return new MountedPathCaller(this, resolved.mount.path);
    }
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

  private resolveMountTarget(target: Mount["target"]): unknown {
    switch (target.type) {
      case "dynamic-worker":
        throw new Error("Dynamic-worker mounts must be invoked through callMounted.");
      case "ctx":
        return this.resolveContextCall(target.call ?? []);
    }
  }

  private resolveContextCall(call: readonly TargetCall[]): unknown {
    return resolveTargetCall(this.#iterateCapability, call);
  }

  resolveDynamicWorkerTarget(target: Extract<MountTarget, { type: "dynamic-worker" }>) {
    return this.#iterateCapability.resolveDynamicWorkerTarget(target);
  }

  private async invokeDynamicWorkerMount(input: {
    args: unknown[];
    invoke: "target" | "method" | "catchall";
    remainder: string[];
    target: Extract<MountTarget, { type: "dynamic-worker" }>;
  }) {
    if (input.invoke === "catchall") {
      return await invokeTargetCall(
        this.resolveDynamicWorkerTarget(input.target),
        input.target.call ?? [],
        [{ path: input.remainder, args: input.args }],
      );
    }

    const call = [...(input.target.call ?? []), ...input.remainder];
    return await invokeTargetCall(this.resolveDynamicWorkerTarget(input.target), call, input.args);
  }
}

export function createIterateContext(input: IterateContextRuntime) {
  return new IterateContext({
    iterateCapability: new IterateCapability(input),
    mounts: [...mountsFromScopes(input), ...(input.props.mounts ?? [])],
  });
}

export function createProjectsCapability(input: { context: AppContext }) {
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
    createProjectContext: ({ project, projectId, projects }) =>
      new ProjectContextCapability({
        project,
        projectId,
        runtime: {
          context: input.context,
          projects,
          props: { scopes: { projects: [projectId] } },
        },
      }),
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

class ProjectReposCapability extends RpcTarget {
  readonly #runtime: IterateContextRuntime;

  constructor(runtime: IterateContextRuntime) {
    super();
    this.#runtime = runtime;
  }

  async create(input: Parameters<ReposClient["create"]>[0]) {
    return await this.#repos().create(input);
  }

  async createInfo(input: Parameters<ReposClient["createInfo"]>[0]) {
    return await this.#repos().createInfo(input);
  }

  async ensureIterateConfigInfo(input: Parameters<ReposClient["ensureIterateConfigInfo"]>[0]) {
    return await ensureIterateConfigInfoForProject({
      env: this.#runtime.context.callableEnv as Pick<ReposCapabilityEnv, "REPO">,
      projectId: requireRuntimeProjectId(this.#runtime),
      projectSlug: input.projectSlug,
    });
  }

  async get(input: Parameters<ReposClient["get"]>[0]) {
    return await this.#repos().get(input);
  }

  async getInfo(input: Parameters<ReposClient["getInfo"]>[0]) {
    return await this.#repos().getInfo(input);
  }

  async list() {
    return await this.#repos().list();
  }

  #repos(): ReposClient {
    const projectId = requireRuntimeProjectId(this.#runtime);
    return getReposCapability({
      exports: this.#runtime.context.workerExports,
      props: { projectId },
    });
  }
}

class ProjectStreamsCapability extends RpcTarget {
  readonly #runtime: IterateContextRuntime;

  constructor(runtime: IterateContextRuntime) {
    super();
    this.#runtime = runtime;
  }

  async append(input: Parameters<StreamsClient["append"]>[0]) {
    return await this.#streams().append(input);
  }

  async appendBatch(input: Parameters<StreamsClient["appendBatch"]>[0]) {
    return await this.#streams().appendBatch(input);
  }

  async create(input: Parameters<StreamsClient["create"]>[0]) {
    return await this.#streams().create(input);
  }

  async getState(input: Parameters<StreamsClient["getState"]>[0]) {
    return await this.#streams().getState(input);
  }

  async list() {
    return await this.#streams().list();
  }

  async listChildren(input: Parameters<StreamsClient["listChildren"]>[0]) {
    return await this.#streams().listChildren(input);
  }

  async read(input: Parameters<StreamsClient["read"]>[0]) {
    return await this.#streams().read(input);
  }

  #streams(): StreamsClient {
    const projectId = requireRuntimeProjectId(this.#runtime);
    return getStreamsCapability({
      exports: this.#runtime.context.workerExports,
      props: {
        appendPolicy: { mode: "any" },
        projectId,
      },
    });
  }
}

class ProjectWorkspaceCapability extends RpcTarget {
  readonly #workspace: WorkspaceClient;
  #git?: ProjectWorkspaceGitCapability;

  constructor(runtime: IterateContextRuntime) {
    super();
    const workspaceCapability = runtime.context.workerExports
      ?.WorkspaceCapability as unknown as (options: {
      props: { projectId: string; workspaceId: string };
    }) => WorkspaceClient;
    if (!workspaceCapability) throw new Error("WorkspaceCapability export is not available.");
    const projectId = requireRuntimeProjectId(runtime);
    this.#workspace = workspaceCapability({
      props: {
        projectId,
        workspaceId: "capnweb",
      },
    });
  }

  get git() {
    return (this.#git ??= new ProjectWorkspaceGitCapability(this.#workspace));
  }

  async readFile(path: string) {
    return await this.#workspace.readFile(path);
  }

  async writeFile(path: string, content: string) {
    return await this.#workspace.writeFile(path, content);
  }
}

class ProjectWorkspaceGitCapability extends RpcTarget {
  readonly #workspace: WorkspaceClient;

  constructor(workspace: WorkspaceClient) {
    super();
    this.#workspace = workspace;
  }

  async add(input: Record<string, unknown>) {
    return await this.#workspace.gitAdd(input);
  }

  async clone(input: Record<string, unknown>) {
    return await this.#workspace.gitClone(input);
  }

  async commit(input: Record<string, unknown>) {
    return await this.#workspace.gitCommit(input);
  }

  async push(input: Record<string, unknown>) {
    return await this.#workspace.gitPush(input);
  }

  async status(input: Record<string, unknown>) {
    return await this.#workspace.gitStatus(input);
  }
}

class MountedPathCaller extends RpcTarget {
  constructor(
    private readonly context: IterateContext,
    private readonly path: string[],
  ) {
    super();
  }

  async call(input: { args?: unknown[]; path: string[] }) {
    return await this.context.callMounted([...this.path, ...input.path], input.args ?? []);
  }
}

function localPathCaller(call: MountedPathCaller) {
  // The marker must be a string key so structured clone preserves it across
  // Cap'n Web and Workers RPC. The RpcTarget travels by reference in `call`.
  return {
    [LOCAL_PATH_CALLER_MARK]: true,
    call,
  };
}

class ProjectWorkerCapability extends RpcTarget {
  constructor(private readonly project: ProjectCapabilityApi) {
    super();
    return createCallablePathProxy(this, [], async (path, args) => {
      if (path.length !== 1) {
        throw new Error(`Project worker path ${path.join(".")} is not supported yet.`);
      }
      return await this.project.callConfigWorkerFunction({
        args,
        functionName: path[0]!,
      });
    }) as ProjectWorkerCapability;
  }

  async fetch(request: Request) {
    return await this.project.fetch(request);
  }
}

function createCallablePathProxy(
  target: RpcTarget,
  path: string[],
  call: (path: string[], args: unknown[]) => unknown,
): object {
  return new Proxy(target, {
    get(innerTarget, prop, receiver) {
      if (typeof prop === "symbol" || prop in innerTarget) {
        return Reflect.get(innerTarget, prop, receiver);
      }
      if (prop === "then") return undefined;
      return createCallableFunctionProxy([...path, prop], call);
    },
  });
}

function createCallableFunctionProxy(
  path: string[],
  call: (path: string[], args: unknown[]) => unknown,
): (...args: unknown[]) => unknown {
  const fn = (...args: unknown[]) => call(path, args);
  return new Proxy(fn, {
    get(innerTarget, prop, receiver) {
      if (typeof prop === "symbol" || prop in innerTarget) {
        return Reflect.get(innerTarget, prop, receiver);
      }
      if (prop === "then") return undefined;
      return createCallableFunctionProxy([...path, prop], call);
    },
  });
}

function mountsFromScopes(runtime: IterateContextRuntime): Mount[] {
  const mounts: Mount[] = [{ path: ["projects"], target: { call: ["projects"], type: "ctx" } }];

  const projectId = singleProjectIdFromScopes(runtime.props.scopes);
  if (projectId) {
    const projectTarget = {
      call: ["projects", { method: "get", args: [projectId] }],
      type: "ctx",
    } satisfies MountTarget;

    mounts.push(
      { path: ["project"], target: projectTarget },
      { path: ["repos"], target: { ...projectTarget, call: [...projectTarget.call, "repos"] } },
      { path: ["streams"], target: { ...projectTarget, call: [...projectTarget.call, "streams"] } },
      {
        path: ["workspace"],
        target: { ...projectTarget, call: [...projectTarget.call, "workspace"] },
      },
      { path: ["worker"], target: { ...projectTarget, call: [...projectTarget.call, "worker"] } },
    );
  }

  return mounts;
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

    // Target and catchall mounts are prototype getters on this one context
    // instance. Different IterateContext instances can therefore expose
    // different mounted roots without leaking names or mount definitions.
    Object.defineProperty(prototype, rootName, {
      configurable: true,
      get(this: IterateContext) {
        if (rootMount) return this.getMounted(rootMount.path);
        return localPathCaller(new MountedPathCaller(this, [rootName]));
      },
    });
  }

  Object.setPrototypeOf(context, prototype);
}

function resolveMount(mounts: Mount[], path: string[]) {
  const candidates = mounts
    .filter((mount) => isPathPrefix(mount.path, path))
    .sort((left, right) => right.path.length - left.path.length);
  const mount = candidates[0];
  if (!mount) return null;
  return {
    mount,
    remainder: path.slice(mount.path.length),
  };
}

function isPathPrefix(prefix: string[], path: string[]) {
  return prefix.every((segment, index) => path[index] === segment);
}

function resolveTargetCall(target: unknown, call: readonly TargetCall[]): unknown {
  let current = target;
  for (const step of call) {
    if (current == null) {
      throw new Error(`Cannot resolve target call through ${String(current)}.`);
    }

    if (typeof step === "string") {
      const parent = current;
      const value = (parent as Record<string, unknown>)[step];
      current = typeof value === "function" ? value.bind(parent) : value;
      continue;
    }

    const method = (current as Record<string, unknown>)[step.method];
    if (typeof method !== "function") {
      throw new Error(`Target method ${step.method} is not callable.`);
    }
    current = method.apply(current, step.args ?? []);
  }
  return current;
}

async function invokeTargetCall(
  target: unknown,
  call: readonly TargetCall[],
  args: unknown[],
): Promise<unknown> {
  let current = target;
  for (let index = 0; index < call.length; index++) {
    if (current == null) {
      throw new Error(`Cannot resolve target call through ${String(current)}.`);
    }

    const step = call[index]!;
    const isLast = index === call.length - 1;
    if (typeof step === "string") {
      const value = (current as Record<string, unknown>)[step];
      if (isLast) {
        if (typeof value !== "function") {
          throw new Error(`Target method ${step} is not callable.`);
        }
        return await value.apply(current, args);
      }
      current = value;
      continue;
    }

    const method = (current as Record<string, unknown>)[step.method];
    if (typeof method !== "function") {
      throw new Error(`Target method ${step.method} is not callable.`);
    }
    const result = method.apply(current, step.args ?? []);
    if (isLast) {
      if (args.length > 0) {
        if (typeof result !== "function") {
          throw new Error(`Target method ${step.method} did not return a callable value.`);
        }
        return await result(...args);
      }
      return await result;
    }
    current = result;
  }

  if (typeof current !== "function") {
    throw new Error("Mounted target did not resolve to a function.");
  }
  return await current(...args);
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
