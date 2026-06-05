import { RpcTarget } from "cloudflare:workers";
import { newWorkersRpcResponse } from "capnweb";
import { ORPCError } from "@orpc/server";
import { isValidTypeId, typeid } from "@iterate-com/shared/typeid";
import type { AppConfig } from "~/app.ts";
import { authenticateAdminApiSecret } from "~/auth/middleware.ts";
import { createAuthWorkerServiceClient } from "~/auth/auth-worker-service.ts";
import type { AppContext } from "~/context.ts";
import {
  countAllProjects,
  countProjects,
  deleteProject,
  getProjectById,
  getProjectBySlug,
  getProjectPermission,
  insertProject,
  insertProjectPermission,
  listAllProjects,
  listProjects,
} from "~/db/queries/.generated/index.ts";
import {
  getProjectDurableObjectName,
  type ProjectDurableObject,
} from "~/domains/projects/durable-objects/project-durable-object.ts";
import type { ActiveOrganizationAuth } from "~/lib/active-organization-auth.ts";
import { createIterateContext } from "./iterate-context-capability.ts";

export const ADMIN_CAPNWEB_PREFIX = "/api/captnweb/admin";

type ProjectRow = {
  id: string;
  slug: string;
  custom_hostname?: string | null;
  created_at: string;
  updated_at: string;
};

type ProjectListResult = {
  projects: ReturnType<typeof toProject>[];
  total: number;
};

type ProjectWithIngressUrl = ReturnType<typeof toProject> & {
  ingressUrl: string;
};

type CaptnwebVars = Record<string, unknown>;

export class IterateAdminCapability extends RpcTarget {
  #projects?: ProjectAdminCapability;

  constructor(
    private readonly props: {
      activeOrganization?: ActiveOrganizationAuth;
      context: AppContext;
    },
  ) {
    super();
  }

  get projects() {
    return (this.#projects ??= new ProjectAdminCapability(this.props));
  }
}

export class ProjectAdminCapability extends RpcTarget {
  constructor(
    private readonly props: {
      activeOrganization?: ActiveOrganizationAuth;
      context: AppContext;
    },
  ) {
    super();
  }

  get(projectId: string) {
    const project = projectDurableObject(this.props.context, projectId);
    return createIterateContext({
      context: this.props.context,
      project,
      projectId,
    });
  }

  async list(input: { limit?: number; offset?: number } = {}): Promise<ProjectListResult> {
    const context = this.props.context;
    const activeOrganization = this.props.activeOrganization;
    const limit = input.limit ?? 100;
    const offset = input.offset ?? 0;
    const [totalRow, rows] = await Promise.all([
      activeOrganization?.isAdminApi
        ? countAllProjects(context.db)
        : countProjects(context.db, {
            principalId: requireActiveOrganization(activeOrganization).orgId,
            principalType: "clerk_organization",
          }),
      activeOrganization?.isAdminApi
        ? listAllProjects(context.db, { limit, offset })
        : listProjects(context.db, {
            limit,
            offset,
            principalId: requireActiveOrganization(activeOrganization).orgId,
            principalType: "clerk_organization",
          }),
    ]);

    return { projects: rows.map(toProject), total: totalRow?.total ?? 0 };
  }

  async create(input: { id?: string; slug: string }): Promise<ProjectWithIngressUrl> {
    const context = this.props.context;
    const activeOrganization = this.props.activeOrganization;
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

  async find(input: { id: string }) {
    const row = await requireProject({
      activeOrganization: this.props.activeOrganization,
      context: this.props.context,
      projectId: input.id,
    });
    return await toProjectWithIngressUrl(this.props.context, row);
  }

  async findBySlug(input: { slug: string }) {
    const row = await getProjectBySlug(this.props.context.db, { slug: input.slug });
    if (!row) {
      throw new ORPCError("NOT_FOUND", { message: `Project ${input.slug} not found` });
    }
    await requireProject({
      activeOrganization: this.props.activeOrganization,
      context: this.props.context,
      projectId: row.id,
    });
    return await toProjectWithIngressUrl(this.props.context, row);
  }

  async remove(input: { id: string }): Promise<{ ok: true; id: string; deleted: boolean }> {
    try {
      await requireProject({
        activeOrganization: this.props.activeOrganization,
        context: this.props.context,
        projectId: input.id,
      });
    } catch (error) {
      if (error instanceof ORPCError && error.code === "NOT_FOUND") {
        return { ok: true, id: input.id, deleted: false };
      }
      throw error;
    }

    await deleteProject(this.props.context.db, { id: input.id });
    const existing = await getProjectById(this.props.context.db, { id: input.id });
    if (existing) {
      return { ok: true, id: input.id, deleted: false };
    }
    return { ok: true, id: input.id, deleted: true };
  }
}

export async function handleAdminCapnwebFetch(input: {
  config: AppConfig;
  context: AppContext;
  env: Env;
  request: Request;
}): Promise<Response | null> {
  const url = new URL(input.request.url);
  if (
    url.pathname !== ADMIN_CAPNWEB_PREFIX &&
    !url.pathname.startsWith(`${ADMIN_CAPNWEB_PREFIX}/`)
  ) {
    return null;
  }

  const principal = authenticateAdminApiSecret({ config: input.config }, input.request);
  if (!principal) return new Response("Unauthorized", { status: 401 });

  if (url.pathname === `${ADMIN_CAPNWEB_PREFIX}/run`) {
    return await handleAdminRunLeg(input);
  }

  return newWorkersRpcResponse(
    input.request,
    new IterateAdminCapability({
      activeOrganization: {
        isAdminApi: true,
        orgId: "admin-api",
        orgPermissions: [],
        orgRole: "admin",
        orgSlug: "admin-api",
        sessionId: "admin-api",
        userId: "admin-api",
      },
      context: input.context,
    }),
  );
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

export function toProject(row: ProjectRow) {
  return {
    id: row.id,
    slug: row.slug,
    customHostname: row.custom_hostname ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function toProjectWithIngressUrl(context: AppContext, row: ProjectRow) {
  return {
    ...toProject(row),
    ingressUrl: await projectDurableObject(context, row.id).ingressUrl(),
  };
}

export async function requireProject(input: {
  activeOrganization?: ActiveOrganizationAuth;
  context: AppContext;
  projectId: string;
}): Promise<ProjectRow> {
  const project = await getProjectById(input.context.db, { id: input.projectId });

  if (!project) {
    throw new ORPCError("NOT_FOUND", {
      message: `Project ${input.projectId} not found`,
    });
  }

  if (input.activeOrganization?.isAdminApi) return project;

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

function projectDurableObject(context: AppContext, projectId: string) {
  if (!context.projectDurableObjectNamespace) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "PROJECT binding not available.",
    });
  }
  return (
    context.projectDurableObjectNamespace as DurableObjectNamespace<ProjectDurableObject>
  ).getByName(getProjectDurableObjectName(projectId));
}

function requireActiveOrganization(activeOrganization: ActiveOrganizationAuth | undefined) {
  if (!activeOrganization) {
    throw new ORPCError("UNAUTHORIZED", { message: "Active organization is required." });
  }
  return activeOrganization;
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}

function adminRunWorkerSrc(code: string) {
  return /* js */ `
  import { WorkerEntrypoint } from "cloudflare:workers";
  const snippet = (${code});
  export default class extends WorkerEntrypoint {
    run({ admin, vars }) {
      return snippet({ admin, vars });
    }
  }
`;
}

async function handleAdminRunLeg(input: { context: AppContext; env: Env; request: Request }) {
  if (!input.env.LOADER) {
    return Response.json({ error: "LOADER binding not available" }, { status: 503 });
  }
  const body = (await input.request.json()) as { code?: string; vars?: CaptnwebVars };
  if (typeof body.code !== "string" || body.code.trim() === "") {
    return Response.json({ error: "code is required" }, { status: 400 });
  }
  const worker = input.env.LOADER.load({
    compatibilityDate: "2026-04-27",
    mainModule: "entry.js",
    modules: { "entry.js": adminRunWorkerSrc(body.code) },
  });
  const entry = worker.getEntrypoint() as unknown as {
    run(input: { admin: IterateAdminCapability; vars: CaptnwebVars }): unknown;
  } & Partial<Disposable>;
  try {
    return Response.json(
      await entry.run({
        admin: new IterateAdminCapability({ context: input.context }),
        vars: body.vars ?? {},
      }),
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  } finally {
    entry[Symbol.dispose]?.();
  }
}
