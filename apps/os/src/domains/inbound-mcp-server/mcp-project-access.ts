import type { ClerkClient } from "@clerk/backend";
import type {
  ProjectDurableObject,
  ProjectSummary,
} from "~/domains/projects/durable-objects/project-durable-object.ts";
import type { ProjectMcpServerConnectionProps } from "~/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts";

export async function resolveMcpProjectAccess(input: {
  auth: ProjectMcpServerConnectionProps;
  clerk: ClerkClient;
  project: DurableObjectStub<ProjectDurableObject>;
}): Promise<{ auth: ProjectMcpServerConnectionProps; project: ProjectSummary } | null> {
  if (input.auth.clientId === "admin-api-secret") {
    return { auth: input.auth, project: await input.project.getSummary() };
  }

  if (input.auth.orgId) {
    const project = await tryCheckMcpProjectAccess({
      auth: input.auth,
      orgId: input.auth.orgId,
      project: input.project,
    });
    if (project) {
      return { auth: input.auth, project };
    }
  }

  return findMcpProjectMembershipAccess({
    auth: input.auth,
    clerk: input.clerk,
    project: input.project,
  });
}

async function findMcpProjectMembershipAccess(input: {
  auth: ProjectMcpServerConnectionProps;
  clerk: ClerkClient;
  project: DurableObjectStub<ProjectDurableObject>;
}) {
  const limit = 100;
  let offset = 0;

  while (true) {
    const memberships = await input.clerk.users.getOrganizationMembershipList({
      limit,
      offset,
      userId: input.auth.userId,
    });

    for (const membership of memberships.data) {
      const project = await tryCheckMcpProjectAccess({
        auth: input.auth,
        orgId: membership.organization.id,
        project: input.project,
      });
      if (!project) {
        continue;
      }

      return {
        auth: {
          ...input.auth,
          orgId: membership.organization.id,
          orgPermissions: membership.permissions,
          orgRole: membership.role,
          orgSlug: membership.organization.slug ?? null,
        },
        project,
      };
    }

    offset += memberships.data.length;
    if (memberships.data.length === 0 || offset >= memberships.totalCount) {
      return null;
    }
  }
}

async function tryCheckMcpProjectAccess(input: {
  auth: ProjectMcpServerConnectionProps;
  orgId: string;
  project: DurableObjectStub<ProjectDurableObject>;
}) {
  try {
    return await input.project.checkAccess({
      principal: {
        orgId: input.orgId,
        userId: input.auth.userId,
      },
    });
  } catch {
    return null;
  }
}
