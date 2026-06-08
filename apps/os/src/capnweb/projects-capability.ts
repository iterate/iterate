import { RpcTarget } from "cloudflare:workers";
import { ORPCError } from "@orpc/server";
import { isValidTypeId, typeid } from "@iterate-com/shared/typeid";
import { ProjectCapability } from "./project-capability.ts";
import type { IterateContextProps } from "./iterate-context-capability.ts";
import { createAuthWorkerServiceClient } from "~/auth/auth-worker-service.ts";
import type { AppContext } from "~/context.ts";
import {
  countAllProjects,
  deleteProject,
  getProjectById,
  getProjectBySlug,
  insertProject,
  listAllProjects,
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

type ProjectListItem = {
  id: string;
  slug: string;
  customHostname: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  isOrphanedProjectFromAuthService: boolean;
};

type ProjectListResult = {
  projects: ProjectListItem[];
  total: number;
};

type ProjectWithIngressUrl = ProjectListItem & {
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
      iterateContextProps?: IterateContextProps;
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
      iterateContextProps: this.props.iterateContextProps,
      project: project.getCapability({ scopes: { projects: [projectId] } }),
      projectId,
    });
  }

  async list(input: { limit?: number; offset?: number } = {}): Promise<ProjectListResult> {
    const context = this.props.context;
    const activeOrganization = this.props.activeOrganization;
    const limit = input.limit ?? 100;
    const offset = input.offset ?? 0;
    if (activeOrganization?.isAdminApi) {
      const [totalRow, rows] = await Promise.all([
        countAllProjects(context.db),
        listAllProjects(context.db, { limit, offset }),
      ]);

      return { projects: rows.map(toProject), total: totalRow?.total ?? 0 };
    }

    const authProjects = await listAuthProjectsForActiveOrganization({
      activeOrganization: requireActiveOrganization(activeOrganization),
      context,
    });
    const page = authProjects.slice(offset, offset + limit);
    const projects = await Promise.all(
      page.map(async (authProject) => {
        const row = await getProjectById(context.db, { id: authProject.id });
        return row ? toProject(row) : toOrphanedProjectFromAuthService(authProject);
      }),
    );

    return { projects, total: authProjects.length };
  }

  async create(input: { id?: string; slug: string }): Promise<ProjectWithIngressUrl> {
    const context = this.props.context;
    const activeOrganization = this.props.activeOrganization;
    const authProject =
      activeOrganization && !activeOrganization.isAdminApi && input.id
        ? await getAccessibleAuthProject({
            activeOrganization,
            context,
            projectId: input.id,
          })
        : null;

    if (activeOrganization && !activeOrganization.isAdminApi && input.id && !authProject) {
      throw new ORPCError("FORBIDDEN", {
        message: `Project ${input.id} is not available to this organization.`,
      });
    }

    const id = authProject?.id ?? resolveProjectId({ id: input.id, context });
    let slug = authProject?.slug ?? input.slug;
    const existingById = await getProjectById(context.db, { id });
    if (existingById) {
      if (existingById.slug !== slug) {
        throw new ORPCError("CONFLICT", {
          message: `Project ${id} already exists with slug ${existingById.slug}.`,
        });
      }
      return await toProjectWithIngressUrl(context, existingById);
    }

    if (activeOrganization && !activeOrganization.isAdminApi && !authProject) {
      const authWorker = createAuthWorkerServiceClient(context);
      const createdAuthProject = await authWorker.internal.project.createForOrganization({
        id,
        organizationSlug: activeOrganization.orgSlug,
        name: slug,
        slug,
        metadata: { osProjectId: id },
      });
      if (createdAuthProject.id !== id) {
        throw new Error(
          `Auth project creation returned ${createdAuthProject.id} instead of requested ${id}.`,
        );
      }
      slug = createdAuthProject.slug;
    }

    const existing = await getProjectBySlug(context.db, { slug });
    if (existing) {
      throw new ORPCError("CONFLICT", {
        message: `A project with slug ${slug} already exists.`,
      });
    }

    let project: ProjectRow;
    try {
      project = await insertProject(context.db, {
        id,
        slug,
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ORPCError("CONFLICT", {
          message: `A project with slug ${slug} already exists.`,
        });
      }
      throw error;
    }

    try {
      await projectDurableObject(context, id).createProject({
        projectId: id,
        slug,
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

export function toProject(row: ProjectRow): ProjectListItem {
  return {
    id: row.id,
    slug: row.slug,
    customHostname: row.custom_hostname ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isOrphanedProjectFromAuthService: false,
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

  if (input.context.principal?.can("read", { projectId: input.projectId })) {
    return project;
  }

  if (
    input.activeOrganization &&
    (await getAccessibleAuthProject({
      activeOrganization: input.activeOrganization,
      context: input.context,
      projectId: input.projectId,
    }))
  ) {
    return project;
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

export type AuthProject = {
  id: string;
  slug: string;
  organizationId: string;
};

function toOrphanedProjectFromAuthService(project: AuthProject): ProjectListItem {
  return {
    id: project.id,
    slug: project.slug,
    customHostname: null,
    createdAt: null,
    updatedAt: null,
    isOrphanedProjectFromAuthService: true,
  };
}

async function listAuthProjectsForActiveOrganization(input: {
  activeOrganization: ActiveOrganizationAuth;
  context: AppContext;
}): Promise<AuthProject[]> {
  if (input.context.principal?.type === "user") {
    const authWorker = createAuthWorkerServiceClient(input.context, {
      asUserId: input.context.principal.userId,
    });
    const projects = await authWorker.project.list({
      organizationSlug: input.activeOrganization.orgSlug,
    });
    return sortAuthProjects(projects);
  }

  return [];
}

export async function getAccessibleAuthProject(input: {
  activeOrganization: ActiveOrganizationAuth;
  context: AppContext;
  projectId: string;
}) {
  const projects = await listAuthProjectsForActiveOrganization(input);
  return projects.find((project) => project.id === input.projectId) ?? null;
}

function sortAuthProjects<T extends Pick<AuthProject, "slug">>(projects: T[]) {
  return [...projects].sort((a, b) => a.slug.localeCompare(b.slug));
}
