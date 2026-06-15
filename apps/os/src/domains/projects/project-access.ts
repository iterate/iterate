import { ORPCError } from "@orpc/server";
import type { RequestContext } from "~/request-context.ts";
import { getProjectById, getProjectBySlug } from "~/db/queries/.generated/index.ts";
import { isProjectId } from "~/domains/projects/project-id.ts";
import { principalIsAdmin } from "~/auth/principal.ts";

/**
 * Confirms a caller can access an ownerless project before exposing
 * project-scoped capabilities such as Code Mode or stream access. Projects are
 * deliberately not owned by organizations at their core; user access is claimed
 * through signed Auth project claims, and admin API callers bypass that for
 * operator work.
 */
export async function requireAuthorizedProject(input: {
  context: RequestContext;
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

  if (canReadProject(input.context, input.projectId)) {
    return project;
  }

  throw new ORPCError("FORBIDDEN", {
    message: `Project ${input.projectId} not found`,
  });
}

export async function requireProjectScopedAccess(input: {
  context: RequestContext;
  projectSlugOrId: string;
}) {
  const project = await resolveProjectBySlugOrId(input);

  if (!input.context.principal) {
    throw new ORPCError("UNAUTHORIZED");
  }

  if (canReadProject(input.context, project.id)) {
    return project;
  }

  throw new ORPCError("FORBIDDEN", {
    message: `Project ${input.projectSlugOrId} is not accessible.`,
  });
}

export function canReadProject(context: Pick<RequestContext, "principal">, projectId: string) {
  return (
    (context.principal != null && principalIsAdmin(context.principal)) ||
    context.principal?.can("read", { projectId }) === true
  );
}

async function resolveProjectBySlugOrId(input: {
  context: RequestContext;
  projectSlugOrId: string;
}) {
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
