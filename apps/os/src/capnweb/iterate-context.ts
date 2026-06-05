import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { createRequestLogger } from "@iterate-com/shared/request-logging";
import { createD1Client } from "sqlfu";
import manifest, { AppConfig } from "~/app.ts";
import type { AppContext } from "~/context.ts";
import { getProjectById } from "~/db/queries/.generated/index.ts";
import {
  getProjectDurableObjectName,
  type ProjectDurableObject,
} from "~/domains/projects/durable-objects/project-durable-object.ts";
import {
  getReposCapability,
  type ReposCapability,
} from "~/domains/repos/entrypoints/repo-capability.ts";
import {
  getStreamsCapability,
  type StreamsCapability,
} from "~/domains/streams/entrypoints/streams-capability.ts";
import type { WorkspaceCapability } from "~/domains/workspaces/entrypoints/workspace-capability.ts";

type RuntimeContext = Pick<ExecutionContext, "exports" | "waitUntil">;

export type ProjectDurableObjectContextClient = Pick<
  ProjectDurableObject,
  "callConfigWorkerFunction" | "getSummary" | "ingressUrl"
>;

export type IterateContextRuntime = {
  context: AppContext;
  project: ProjectDurableObjectContextClient;
  projectId: string;
};

type ProjectRow = {
  id: string;
  slug: string;
  custom_hostname?: string | null;
  created_at: string;
  updated_at: string;
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

export class IterateContextEntrypoint extends WorkerEntrypoint<Env, { projectId: string }> {
  get ctx() {
    return this.env.PROJECT.getByName(
      getProjectDurableObjectName(this.ctx.props.projectId),
    ).getIterateContext();
  }
}

export class IterateContext extends RpcTarget {
  readonly #runtime: IterateContextRuntime;
  #project?: ProjectInfoCapability;
  #repos?: ProjectReposCapability;
  #streams?: ProjectStreamsCapability;
  #workspace?: ProjectWorkspaceCapability;
  #worker?: ProjectWorkerCapability;

  constructor(runtime: IterateContextRuntime) {
    super();
    this.#runtime = runtime;
  }

  get project() {
    return (this.#project ??= new ProjectInfoCapability(this.#runtime));
  }

  get repos() {
    return (this.#repos ??= new ProjectReposCapability(this.#runtime));
  }

  get streams() {
    return (this.#streams ??= new ProjectStreamsCapability(this.#runtime));
  }

  get workspace() {
    return (this.#workspace ??= new ProjectWorkspaceCapability(this.#runtime));
  }

  get worker() {
    return (this.#worker ??= createProjectWorkerCapability(this.#runtime));
  }
}

export function createIterateContext(input: IterateContextRuntime) {
  return new IterateContext(input);
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

class ProjectInfoCapability extends RpcTarget {
  readonly #runtime: IterateContextRuntime;

  constructor(runtime: IterateContextRuntime) {
    super();
    this.#runtime = runtime;
  }

  get id() {
    return this.#runtime.projectId;
  }

  async describe() {
    const row = await getProjectById(this.#runtime.context.db, { id: this.#runtime.projectId });
    if (!row) throw new Error(`Project ${this.#runtime.projectId} not found`);
    return {
      ...toProject(row),
      ingressUrl: await this.#runtime.project.ingressUrl(),
    };
  }
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
    return await this.#repos().ensureIterateConfigInfo(input);
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
    return getReposCapability({
      exports: this.#runtime.context.workerExports,
      props: { projectId: this.#runtime.projectId },
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
    return getStreamsCapability({
      exports: this.#runtime.context.workerExports,
      props: {
        appendPolicy: { mode: "any" },
        projectId: this.#runtime.projectId,
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
    this.#workspace = workspaceCapability({
      props: {
        projectId: runtime.projectId,
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

export type ProjectWorkerMethods = ProjectWorkerCapability &
  Record<string, (...args: unknown[]) => Promise<unknown>>;

class ProjectWorkerCapability extends RpcTarget {
  readonly #runtime: IterateContextRuntime;

  constructor(runtime: IterateContextRuntime) {
    super();
    this.#runtime = runtime;
  }

  async call(input: { args?: unknown[]; functionName: string }): Promise<unknown> {
    return await this.#runtime.project.callConfigWorkerFunction(input);
  }

  async fetchJson(input: { url: string }): Promise<unknown> {
    const response = (await this.#runtime.project.callConfigWorkerFunction({
      args: [new Request(input.url)],
      functionName: "fetch",
    })) as Response;
    if (!response.ok) throw new Error(await response.text());
    return await response.json();
  }
}

function createProjectWorkerCapability(runtime: IterateContextRuntime): ProjectWorkerMethods {
  const target = new ProjectWorkerCapability(runtime);
  return new Proxy(target, {
    get(receiver, prop) {
      if (typeof prop !== "string") return Reflect.get(receiver, prop, receiver);
      if (prop === "then") return undefined;
      if (prop in receiver) {
        const value = Reflect.get(receiver, prop, receiver);
        return typeof value === "function" ? value.bind(receiver) : value;
      }
      return async (...args: unknown[]) => await receiver.call({ args, functionName: prop });
    },
  }) as ProjectWorkerMethods;
}

function toProject(row: ProjectRow) {
  return {
    id: row.id,
    slug: row.slug,
    customHostname: row.custom_hostname ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
