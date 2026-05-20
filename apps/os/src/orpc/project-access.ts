import { ORPCError } from "@orpc/server";
import type { AppContext } from "~/context.ts";
import {
  getProjectById,
  getProjectBySlug,
  getProjectPermission,
} from "~/db/queries/.generated/index.ts";
import type { ActiveOrganizationAuth } from "~/lib/active-organization-auth.ts";
import { resolveActiveOrganizationAuth } from "~/orpc/auth.ts";

/**
 * Confirms a caller can access an ownerless project before exposing
 * project-scoped capabilities such as Code Mode or stream access. Projects are
 * deliberately not owned by Clerk organizations; the permission table is the
 * current claim/grant layer, and admin API callers bypass it for operator work.
 */
export async function requireActiveOrganizationProject(input: {
  activeOrganization: ActiveOrganizationAuth;
  context: AppContext;
  projectId: string;
}) {
  const project = await getProjectById(input.context.db, {
    id: input.projectId,
  });

  if (!project) {
    throw new ORPCError("NOT_FOUND", {
      message: `Project ${input.projectId} not found`,
    });
  }

  if (input.activeOrganization.isAdminApi) {
    return project;
  }

  const permission = await getProjectPermission(input.context.db, {
    principalId: input.activeOrganization.orgId,
    principalType: "clerk_organization",
    projectId: input.projectId,
  });

  if (!permission) {
    throw new ORPCError("FORBIDDEN", {
      message: `Project ${input.projectId} not found`,
    });
  }

  return project;
}

export async function requireProjectScopedAccess(input: {
  context: AppContext;
  projectSlugOrId: string;
}) {
  if (input.context.projectAccess) {
    if (input.context.projectAccess.projectId !== input.projectSlugOrId) {
      throw new ORPCError("FORBIDDEN", {
        message: "Project-bound caller cannot access another project.",
      });
    }

    return await resolveBoundProject(input);
  }

  const project = await resolveProjectBySlugOrId(input);

  const activeOrganization = resolveActiveOrganizationAuth(input.context);
  if (!activeOrganization) {
    if (input.context.auth?.isAuthenticated) {
      throw new ORPCError("FORBIDDEN", {
        message: "OS requires an active Clerk Organization.",
      });
    }
    throw new ORPCError("UNAUTHORIZED");
  }

  if (activeOrganization.isAdminApi) {
    return project;
  }

  const permission = await getProjectPermission(input.context.db, {
    principalId: activeOrganization.orgId,
    principalType: "clerk_organization",
    projectId: project.id,
  });

  if (!permission) {
    throw new ORPCError("FORBIDDEN", {
      message: `Project ${input.projectSlugOrId} is not accessible.`,
    });
  }

  return project;
}

export function requireProjectScope(
  context: AppContext,
): NonNullable<AppContext["projectScope"]>["project"] {
  if (!context.projectScope) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Project scope middleware did not run.",
    });
  }

  return context.projectScope.project;
}

async function resolveBoundProject(input: { context: AppContext; projectSlugOrId: string }) {
  if (input.context.db) {
    const project = await getProjectById(input.context.db, { id: input.projectSlugOrId });
    if (project) return project;
  }

  const now = new Date().toISOString();
  return {
    id: input.projectSlugOrId,
    slug: input.projectSlugOrId,
    custom_hostname: null,
    created_at: now,
    updated_at: now,
  };
}

async function resolveProjectBySlugOrId(input: { context: AppContext; projectSlugOrId: string }) {
  const projectId = input.projectSlugOrId.trim();
  const project = isProjectId(projectId)
    ? await getProjectById(input.context.db, { id: projectId })
    : await getProjectBySlug(input.context.db, { slug: projectId });

  if (!project) {
    throw new ORPCError("NOT_FOUND", {
      message: `Project ${input.projectSlugOrId} not found`,
    });
  }

  return project;
}

function isProjectId(value: string) {
  return value.startsWith("proj_") || value.startsWith("prj_");
}
