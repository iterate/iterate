import { RpcTarget } from "cloudflare:workers";
import { ORPCError } from "@orpc/server";
import { isValidTypeId, typeid } from "@iterate-com/shared/typeid";
import { ProjectCapability } from "./project-capability.ts";
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
  type ProjectCapabilityApi,
  type ProjectDurableObject,
} from "~/domains/projects/durable-objects/project-durable-object.ts";
import type { ActiveOrganizationAuth } from "~/lib/active-organization-auth.ts";

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

type ProjectDurableObjectContextClient = {
  getCapability(props?: { scopes?: unknown }): ProjectCapabilityApi;
};

export class ProjectsCapability extends RpcTarget {
  constructor(
    private readonly props: {
      activeOrganization?: ActiveOrganizationAuth;
      context: AppContext;
    },
  ) {
    super();
  }

  get(projectId: string) {
    const project = projectDurableObject(
      this.props.context,
      projectId,
    ) as unknown as ProjectDurableObjectContextClient;
    return new ProjectCapability({
      context: this.props.context,
      project: project.getCapability({ scopes: { projects: [projectId] } }),
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
