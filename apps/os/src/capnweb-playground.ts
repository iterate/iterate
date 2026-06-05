/**
 * capnweb-playground — a toy capnweb ("captnweb") capability endpoint at
 * `/api/captnweb`.
 *
 * Everything we're playing with lives in this one file: the capability tree,
 * the scope model, the dynamic-worker (/run) leg, and the request handler.
 *
 * Two RPC systems meet here, and the trick that makes a single capability tree
 * work for both is that capnweb's workers build aliases its own `RpcTarget` to
 * Cloudflare's:
 *
 *   // capnweb/dist/index-workers.js
 *   import * as cfw from "cloudflare:workers";
 *   globalThis[WORKERS_MODULE_SYMBOL] = cfw;
 *   var RpcTarget = workersModule ? workersModule.RpcTarget : class {};
 *
 * So a class that `extends RpcTarget` from "cloudflare:workers" is simultaneously:
 *   1. detected by capnweb as an `rpc-target` and exposed as a live stub over the
 *      WebSocket edge (`newWorkersRpcResponse`), and
 *   2. a real Cloudflare RpcTarget that can be passed by reference into a
 *      WorkerLoader dynamic worker and called with native promise pipelining.
 *
 * Capability constructors take a single props bag (not positional args), per
 * house style (see `WorkerEntrypoint` + `ctx.props` elsewhere in the app).
 *
 * Project capabilities are minted from scopes, but project methods validate
 * against the real app database before exposing project data.
 */
import { RpcTarget } from "cloudflare:workers";
import { newWorkersRpcResponse } from "capnweb";
import { ORPCError } from "@orpc/server";
import { isValidTypeId, typeid } from "@iterate-com/shared/typeid";
import type { AppConfig } from "~/app.ts";
import { authenticateAdminApiSecret } from "~/auth/middleware.ts";
import type { AppContext } from "~/context.ts";
import { createAuthWorkerServiceClient } from "~/auth/auth-worker-service.ts";
import type { ActiveOrganizationAuth } from "~/lib/active-organization-auth.ts";
import {
  deleteProject,
  countAllProjects,
  countProjects,
  getProjectById,
  getProjectPermission,
  getProjectBySlug,
  insertProject,
  insertProjectPermission,
  listAllProjects,
  listProjects,
} from "~/db/queries/.generated/index.ts";
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

export const CAPTNWEB_PREFIX = "/api/captnweb";

const PROJECT_SCOPE_PREFIX = "project:";
const PROJECT_WILDCARD = `${PROJECT_SCOPE_PREFIX}*`;
const CREATE_PROJECT_SCOPE = "create_project";

// ── scope helpers (pure) ───────────────────────────────────────────────────

/** Concrete project ids granted by the scopes. Excludes the "*" wildcard. */
function concreteProjectIds(scopes: string[]): string[] {
  return scopes
    .filter((scope) => scope.startsWith(PROJECT_SCOPE_PREFIX))
    .map((scope) => scope.slice(PROJECT_SCOPE_PREFIX.length))
    .filter((id) => id.length > 0 && id !== "*");
}

function authorizesProject(scopes: string[], projectId: string): boolean {
  return (
    scopes.includes(PROJECT_WILDCARD) || scopes.includes(`${PROJECT_SCOPE_PREFIX}${projectId}`)
  );
}

export interface ProjectDescription {
  id: string;
  slug: string;
  customHostname: string | null;
  createdAt: string;
  updatedAt: string;
}

type CaptnwebVars = Record<string, unknown>;

type ProjectRow = {
  id: string;
  slug: string;
  custom_hostname?: string | null;
  created_at: string;
  updated_at: string;
};

type ProjectSummary = {
  id: string;
  slug: string;
  customHostname: string | null;
  createdAt: string;
  updatedAt: string;
};

type ProjectWithIngressUrl = ProjectSummary & {
  ingressUrl: string;
};

type ProjectListResult = {
  projects: ProjectSummary[];
  total: number;
};

export function toProject(row: ProjectRow): ProjectSummary {
  return {
    id: row.id,
    slug: row.slug,
    customHostname: row.custom_hostname ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function toProjectWithIngressUrl(
  context: AppContext,
  row: ProjectRow,
): Promise<ProjectWithIngressUrl> {
  return {
    ...toProject(row),
    ingressUrl: await projectDurableObject(context, row.id).ingressUrl(),
  };
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}

function resolveProjectId(input: { id?: string; context: Pick<AppContext, "config"> }) {
  if (input.id) {
    if (!isValidTypeId(input.id, "proj")) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Project ID must be a valid TypeID with prefix proj.",
      });
    }
    return input.id;
  }

  return typeid({
    env: { TYPEID_PREFIX: input.context.config.typeIdPrefix.exposeSecret() },
    prefix: "proj",
  });
}

function requireProjectDurableObjectNamespace(context: AppContext) {
  if (!context.projectDurableObjectNamespace) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "PROJECT binding not available.",
    });
  }

  return context.projectDurableObjectNamespace;
}

function projectDurableObject(context: AppContext, projectId: string) {
  return (
    requireProjectDurableObjectNamespace(context) as DurableObjectNamespace<ProjectDurableObject>
  ).getByName(getProjectDurableObjectName(projectId));
}

// ── the capability tree (every node is an RpcTarget; props passed as a bag) ──

export interface IterateCapabilityProps {
  scopes: string[];
  context?: AppContext;
  activeOrganization?: ActiveOrganizationAuth;
}

export class IterateCapability extends RpcTarget {
  readonly #scopes: string[];
  readonly #context: AppContext | undefined;
  readonly #activeOrganization: ActiveOrganizationAuth | undefined;
  #projects?: ProjectsCapability;

  constructor(props: IterateCapabilityProps) {
    super();
    this.#scopes = props.scopes;
    this.#context = props.context;
    this.#activeOrganization = props.activeOrganization;
  }

  // Prototype getter => visible over RPC. Memoised so repeated access is cheap.
  get projects(): ProjectsCapability {
    return (this.#projects ??= new ProjectsCapability({
      activeOrganization: this.#activeOrganization,
      context: this.#context,
      scopes: this.#scopes,
    }));
  }

  // Super edge case: the "current" project. One or more concrete project scopes
  // names the first one; no concrete scope means there is no singular current
  // project, even if the caller has project:*.
  get project(): ProjectCapability {
    const ids = concreteProjectIds(this.#scopes);
    if (ids.length === 0) {
      throw new Error("No current project is available for these scopes.");
    }
    return new ProjectCapability({
      activeOrganization: this.#activeOrganization,
      context: this.#context,
      projectId: ids[0],
      scopes: this.#scopes,
    });
  }

  async whoami(): Promise<{ scopes: string[] }> {
    return { scopes: this.#scopes };
  }

  async testMethod(input: { behavior?: "return" | "throw"; message?: string }) {
    if (input.behavior === "throw") {
      throw new Error(input.message ?? "testMethod requested failure");
    }
    return { ok: true, message: input.message };
  }
}

export interface ProjectsCapabilityProps {
  activeOrganization?: ActiveOrganizationAuth;
  context?: AppContext;
  scopes: string[];
}

export class ProjectsCapability extends RpcTarget {
  readonly #scopes: string[];
  readonly #context: AppContext | undefined;
  readonly #activeOrganization: ActiveOrganizationAuth | undefined;

  constructor(props: ProjectsCapabilityProps) {
    super();
    this.#scopes = props.scopes;
    this.#context = props.context;
    this.#activeOrganization = props.activeOrganization;
  }

  get(projectId: string): ProjectCapability {
    // Enforce the scope before minting the capability, so a caller can't reach
    // a project outside its grant even though the stub proxy "looks like" it
    // has every method.
    if (!this.#activeOrganization && !authorizesProject(this.#scopes, projectId)) {
      throw new Error(`Not authorized for project: ${projectId}`);
    }
    return new ProjectCapability({
      activeOrganization: this.#activeOrganization,
      context: this.#context,
      projectId,
      scopes: this.#scopes,
    });
  }

  async list(input: { limit?: number; offset?: number } = {}): Promise<ProjectListResult> {
    const context = this.#context;
    const activeOrganization = this.#activeOrganization;
    const limit = input.limit ?? 100;
    const offset = input.offset ?? 0;
    if (context && activeOrganization) {
      const [totalRow, rows] = await Promise.all([
        activeOrganization.isAdminApi
          ? countAllProjects(context.db)
          : countProjects(context.db, {
              principalId: activeOrganization.orgId,
              principalType: "clerk_organization",
            }),
        activeOrganization.isAdminApi
          ? listAllProjects(context.db, { limit, offset })
          : listProjects(context.db, {
              limit,
              offset,
              principalId: activeOrganization.orgId,
              principalType: "clerk_organization",
            }),
      ]);
      return { projects: rows.map(toProject), total: totalRow?.total ?? 0 };
    }

    const ids = concreteProjectIds(this.#scopes);
    if (!context) {
      return {
        projects: ids.map((id) => ({
          id,
          slug: id,
          customHostname: null,
          createdAt: "",
          updatedAt: "",
        })),
        total: ids.length,
      };
    }

    if (this.#scopes.includes(PROJECT_WILDCARD)) {
      const [totalRow, rows] = await Promise.all([
        countAllProjects(context.db),
        listAllProjects(context.db, { limit, offset }),
      ]);
      return { projects: rows.map(toProject), total: totalRow?.total ?? 0 };
    }

    const rows = (await Promise.all(ids.map((id) => getProjectById(context.db, { id })))).filter(
      (row) => row != null,
    );
    const projects = rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      customHostname: row.custom_hostname ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    return { projects: projects.slice(offset, offset + limit), total: projects.length };
  }

  async create(input: { id?: string; slug: string }): Promise<ProjectWithIngressUrl> {
    const context = this.#requireContext();
    const activeOrganization = this.#activeOrganization;
    if (!activeOrganization && !this.#scopes.includes(CREATE_PROJECT_SCOPE)) {
      throw new Error("Missing required scope: create_project");
    }

    const id = resolveProjectId({ id: input.id, context });
    const existing = await getProjectBySlug(context.db, { slug: input.slug });
    if (existing) {
      throw new ORPCError("CONFLICT", {
        message: `A project with slug ${input.slug} already exists.`,
      });
    }
    if (input.id && (await getProjectById(context.db, { id: input.id }))) {
      throw new ORPCError("CONFLICT", {
        message: `A project with ID ${input.id} already exists.`,
      });
    }

    if (activeOrganization && !activeOrganization.isAdminApi) {
      const authWorker = createAuthWorkerServiceClient(context);
      await authWorker.internal.project.createForOrganization({
        id,
        organizationSlug: activeOrganization.orgSlug,
        name: input.slug,
        slug: input.slug,
        metadata: { osProjectId: id },
      });
    }

    let project: ProjectRow;
    try {
      project = await insertProject(context.db, {
        id,
        slug: input.slug,
      });
      if (activeOrganization && !activeOrganization.isAdminApi) {
        await insertProjectPermission(context.db, {
          principalId: activeOrganization.orgId,
          principalType: "clerk_organization",
          projectId: id,
          role: "owner",
        });
      }
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ORPCError("CONFLICT", {
          message: `A project with slug ${input.slug} already exists.`,
        });
      }

      throw error;
    }

    try {
      await projectDurableObject(context, id).createProject({
        projectId: id,
        slug: input.slug,
      });
    } catch (error) {
      await deleteProject(context.db, { id }).catch((cleanupError) => {
        console.error(
          `[projects.create] Failed to clean up partial project ${id} after bootstrap failure:`,
          cleanupError,
        );
      });
      throw error;
    }

    return await toProjectWithIngressUrl(context, project);
  }

  async remove(input: { id: string }): Promise<{ ok: true; id: string; deleted: boolean }> {
    const context = this.#requireContext();
    const activeOrganization = this.#activeOrganization;
    if (!activeOrganization && !authorizesProject(this.#scopes, input.id)) {
      throw new Error(`Not authorized for project: ${input.id}`);
    }

    try {
      await requireProject({
        activeOrganization,
        context,
        projectId: input.id,
        scopes: this.#scopes,
      });
    } catch (error) {
      if (error instanceof ORPCError && error.code === "NOT_FOUND") {
        return { ok: true, id: input.id, deleted: false };
      }
      throw error;
    }

    await deleteProject(context.db, { id: input.id });
    const existing = await getProjectById(context.db, { id: input.id });
    if (existing) {
      return { ok: true, id: input.id, deleted: false };
    }
    return { ok: true, id: input.id, deleted: true };
  }

  #requireContext(): AppContext {
    if (!this.#context) {
      throw new Error("ProjectsCapability requires app context for this operation.");
    }
    return this.#context;
  }
}

export interface ProjectCapabilityProps {
  activeOrganization?: ActiveOrganizationAuth;
  context?: AppContext;
  projectId: string;
  scopes?: string[];
}

export class ProjectCapability extends RpcTarget {
  readonly #activeOrganization: ActiveOrganizationAuth | undefined;
  readonly #context: AppContext | undefined;
  readonly #projectId: string;
  readonly #scopes: string[];
  #repos?: CaptnwebReposCapability;
  #streams?: CaptnwebStreamsCapability;
  #workspace?: CaptnwebWorkspaceCapability;
  #worker?: ProjectWorkerMethods;

  constructor(props: ProjectCapabilityProps) {
    super();
    this.#activeOrganization = props.activeOrganization;
    this.#context = props.context;
    this.#projectId = props.projectId;
    this.#scopes = props.scopes ?? [];
  }

  get id(): string {
    return this.#projectId;
  }

  get repos(): CaptnwebReposCapability {
    this.#assertProjectScope();
    return (this.#repos ??= getReposCapability({
      exports: this.#requireContext().workerExports,
      props: { projectId: this.#projectId },
    }));
  }

  get streams(): CaptnwebStreamsCapability {
    this.#assertProjectScope();
    return (this.#streams ??= getStreamsCapability({
      exports: this.#requireContext().workerExports,
      props: {
        appendPolicy: { mode: "any" },
        projectId: this.#projectId,
      },
    }));
  }

  get workspace(): CaptnwebWorkspaceCapability {
    this.#assertProjectScope();
    return (this.#workspace ??= new ProjectWorkspaceCapability({
      context: this.#requireContext(),
      projectId: this.#projectId,
      workspaceId: "captnweb-playground",
    }));
  }

  get worker(): ProjectWorkerMethods {
    return (this.#worker ??= createProjectWorkerCapability({
      activeOrganization: this.#activeOrganization,
      context: this.#context,
      projectId: this.#projectId,
      scopes: this.#scopes,
    }));
  }

  async describe(): Promise<ProjectDescription> {
    const project = await requireProject({
      activeOrganization: this.#activeOrganization,
      context: this.#requireContext(),
      projectId: this.#projectId,
      scopes: this.#scopes,
    });
    return toProject(project);
  }

  #assertProjectScope() {
    if (!this.#activeOrganization && !authorizesProject(this.#scopes, this.#projectId)) {
      throw new Error(`Not authorized for project: ${this.#projectId}`);
    }
  }

  #requireContext(): AppContext {
    if (!this.#context) {
      throw new Error("ProjectCapability requires app context for this operation.");
    }
    return this.#context;
  }
}

type ProjectCapabilityChildProps = {
  activeOrganization?: ActiveOrganizationAuth;
  context?: AppContext;
  projectId: string;
  scopes: string[];
};

type CaptnwebReposCapability = Pick<
  ReposCapability,
  "create" | "createInfo" | "ensureIterateConfigInfo" | "get" | "getInfo" | "list"
>;
type CaptnwebStreamsCapability = Pick<
  StreamsCapability,
  "append" | "appendBatch" | "create" | "getState" | "list" | "listChildren" | "read"
>;
type WorkspaceClient = Pick<
  WorkspaceCapability,
  "gitAdd" | "gitClone" | "gitCommit" | "gitPush" | "gitStatus" | "readFile" | "writeFile"
>;

class ProjectWorkspaceCapability extends RpcTarget {
  readonly #workspace: WorkspaceClient;
  #git?: ProjectWorkspaceGitCapability;

  constructor(input: { context: AppContext; projectId: string; workspaceId: string }) {
    super();
    if (!input.context.workerExports) {
      throw new Error("WorkspaceCapability export is not available.");
    }
    const workspaceCapability = input.context.workerExports
      .WorkspaceCapability as unknown as (options: {
      props: { projectId: string; workspaceId: string };
    }) => WorkspaceClient;
    this.#workspace = workspaceCapability({
      props: {
        projectId: input.projectId,
        workspaceId: input.workspaceId,
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

type CaptnwebWorkspaceCapability = ProjectWorkspaceCapability;

export type ProjectWorkerMethods = ProjectWorkerCapability &
  Record<string, (...args: unknown[]) => Promise<unknown>>;

export class ProjectWorkerCapability extends RpcTarget {
  readonly #activeOrganization: ActiveOrganizationAuth | undefined;
  readonly #context: AppContext | undefined;
  readonly #projectId: string;
  readonly #scopes: string[];

  constructor(props: ProjectCapabilityChildProps) {
    super();
    this.#activeOrganization = props.activeOrganization;
    this.#context = props.context;
    this.#projectId = props.projectId;
    this.#scopes = props.scopes;
  }

  async call(input: { args?: unknown[]; functionName: string }): Promise<unknown> {
    const context = this.#requireContext();
    await requireProject({
      activeOrganization: this.#activeOrganization,
      context,
      projectId: this.#projectId,
      scopes: this.#scopes,
    });
    return await projectDurableObject(context, this.#projectId).callConfigWorkerFunction(input);
  }

  async someFunction(...args: unknown[]): Promise<unknown> {
    return await this.call({ args, functionName: "someFunction" });
  }

  #requireContext(): AppContext {
    if (!this.#context) {
      throw new Error("ProjectWorkerCapability requires app context for this operation.");
    }
    return this.#context;
  }
}

function createProjectWorkerCapability(props: ProjectCapabilityChildProps): ProjectWorkerMethods {
  const target = new ProjectWorkerCapability(props);
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

async function requireProject(input: {
  activeOrganization?: ActiveOrganizationAuth;
  context: AppContext;
  projectId: string;
  scopes: string[];
}): Promise<ProjectRow> {
  const project = await getProjectById(input.context.db, { id: input.projectId });

  if (!project) {
    throw new ORPCError("NOT_FOUND", {
      message: `Project ${input.projectId} not found`,
    });
  }

  if (input.activeOrganization?.isAdminApi || authorizesProject(input.scopes, input.projectId)) {
    return project;
  }

  if (input.activeOrganization) {
    const permission = await getProjectPermission(input.context.db, {
      principalId: input.activeOrganization.orgId,
      principalType: "clerk_organization",
      projectId: input.projectId,
    });
    if (permission) return project;
  }

  throw new ORPCError("FORBIDDEN", {
    message: `Project ${input.projectId} not found`,
  });
}

// ── dynamic worker source (loaded via Worker Loader) ────────────────────────
// The parent passes a live scoped `iterate` target into `run`; snippets call it
// just like the WebSocket tests call their local `iterate` stub.
const DEFAULT_DYNAMIC_WORKER_CODE = /* js */ `
async ({ iterate }) => {
  const list = await iterate.projects.list({ limit: 1 });
  const project = list.projects[0];
  if (!project) throw new Error("No accessible projects are available.");
  return await iterate.projects.get(project.id).describe();
}
`;

function dynamicWorkerSrc(code: string) {
  return /* js */ `
  import { WorkerEntrypoint } from "cloudflare:workers";
  const snippet = (${code});
  export default class extends WorkerEntrypoint {
    run({ iterate, vars }) {
      return snippet({ iterate, vars });
    }
  }
`;
}

// ── auth: admin token -> scopes ─────────────────────────────────────────────
// Toy endpoint: only the admin API secret is accepted. The admin may assume any
// scope set via the `x-iterate-scopes` header (comma-separated, e.g.
// "project:proj_abc,project:*"), defaulting to the wildcard. This is what lets
// the e2e tests drive different scope combinations with the admin token.
function resolveCaptnwebScopes(input: { request: Request; config: AppConfig }): string[] | null {
  const principal = authenticateAdminApiSecret({ config: input.config }, input.request);
  if (!principal) return null;

  const header = input.request.headers.get("x-iterate-scopes");
  const parsed =
    header
      ?.split(",")
      .map((scope) => scope.trim())
      .filter(Boolean) ?? [];
  return parsed.length > 0 ? parsed : [PROJECT_WILDCARD];
}

interface CaptnwebRunEntrypoint {
  run(input: { iterate: IterateCapability; vars: CaptnwebVars }): unknown;
}

function serializeError(error: unknown) {
  return {
    error: error instanceof Error ? error.message : String(error),
  };
}

async function handleRunLeg(input: {
  context: AppContext;
  request: Request;
  url: URL;
  scopes: string[];
  env: Env;
}): Promise<Response> {
  if (!input.env.LOADER) {
    return Response.json({ error: "LOADER binding not available" }, { status: 503 });
  }

  let code = DEFAULT_DYNAMIC_WORKER_CODE;
  let vars: CaptnwebVars = {};
  if (input.request.method === "POST") {
    const body = (await input.request.json()) as { code?: string; vars?: CaptnwebVars };
    if (typeof body.code !== "string" || body.code.trim() === "") {
      return Response.json({ error: "code is required" }, { status: 400 });
    }
    code = body.code;
    vars = body.vars ?? {};
  }

  const worker = input.env.LOADER.load({
    compatibilityDate: "2026-04-27",
    mainModule: "entry.js",
    modules: { "entry.js": dynamicWorkerSrc(code) },
  });

  const entry = worker.getEntrypoint() as unknown as CaptnwebRunEntrypoint & Partial<Disposable>;
  try {
    const result = await entry.run({
      iterate: new IterateCapability({ context: input.context, scopes: input.scopes }),
      vars,
    });
    return Response.json(result);
  } catch (error) {
    return Response.json(serializeError(error), { status: 500 });
  } finally {
    entry[Symbol.dispose]?.();
  }
}

/**
 * Raw worker-`fetch`-level handler for the captnweb endpoint. Returns `null`
 * when the request isn't for us, so `entry.workerd.ts` can fall through to the
 * rest of the app. Lives at the worker boundary (not a TanStack route) because
 * the WebSocket upgrade `Response` needs to reach the runtime untouched.
 */
export async function handleCaptnwebFetch(input: {
  context: AppContext;
  request: Request;
  env: Env;
  config: AppConfig;
}): Promise<Response | null> {
  const url = new URL(input.request.url);
  if (url.pathname !== CAPTNWEB_PREFIX && !url.pathname.startsWith(`${CAPTNWEB_PREFIX}/`)) {
    return null;
  }

  const scopes = resolveCaptnwebScopes({ request: input.request, config: input.config });
  if (!scopes) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (url.pathname === `${CAPTNWEB_PREFIX}/run`) {
    return handleRunLeg({
      context: input.context,
      request: input.request,
      url,
      scopes,
      env: input.env,
    });
  }

  // capnweb edge: handles the POST batch and the WebSocket upgrade.
  return newWorkersRpcResponse(
    input.request,
    new IterateCapability({ context: input.context, scopes }),
  );
}
