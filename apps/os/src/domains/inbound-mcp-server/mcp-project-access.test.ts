import type { ClerkClient } from "@clerk/backend";
import { describe, expect, it, vi } from "vitest";
import { resolveMcpProjectAccess } from "./mcp-project-access.ts";
import type {
  ProjectDurableObject,
  ProjectSummary,
} from "~/domains/projects/durable-objects/project-durable-object.ts";
import type { ProjectMcpServerConnectionProps } from "~/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts";

const projectSummary: ProjectSummary = {
  id: "proj_iterate",
  slug: "iterate",
  defaultHost: "iterate.iterate.app",
  hosts: ["iterate.iterate.app", "mcp__iterate.iterate.app"],
};

function projectStub(checkAccess: (orgId: string) => boolean) {
  return {
    getSummary: vi.fn(async () => projectSummary),
    checkAccess: vi.fn(async (input: { principal: { orgId: string } }) => {
      if (!checkAccess(input.principal.orgId)) {
        throw new Error("no access");
      }
      return projectSummary;
    }),
  } as unknown as DurableObjectStub<ProjectDurableObject>;
}

function clerkStub(
  memberships: Array<{ id: string; slug: string; role: string; permissions: string[] }>,
) {
  return {
    users: {
      getOrganizationMembershipList: vi.fn(async () => ({
        data: memberships.map((membership) => ({
          organization: { id: membership.id, slug: membership.slug },
          permissions: membership.permissions,
          role: membership.role,
        })),
        totalCount: memberships.length,
      })),
    },
  } as unknown as ClerkClient;
}

describe("resolveMcpProjectAccess", () => {
  it("falls back to Clerk org memberships for oauth tokens without a matching org claim", async () => {
    const auth: ProjectMcpServerConnectionProps = {
      clientId: "cursor",
      clerkTokenType: "oauth_token",
      orgId: "org_personal",
      orgPermissions: [],
      orgRole: null,
      orgSlug: null,
      projectId: null,
      projectSlug: null,
      scopes: ["email", "profile"],
      userId: "user_123",
    };

    const result = await resolveMcpProjectAccess({
      auth,
      clerk: clerkStub([
        { id: "org_personal", slug: "personal", role: "org:member", permissions: [] },
        {
          id: "org_iterate",
          slug: "iterate",
          role: "org:admin",
          permissions: ["org:sys_memberships:manage"],
        },
      ]),
      project: projectStub((orgId) => orgId === "org_iterate"),
    });

    expect(result).toEqual({
      auth: {
        ...auth,
        orgId: "org_iterate",
        orgPermissions: ["org:sys_memberships:manage"],
        orgRole: "org:admin",
        orgSlug: "iterate",
      },
      project: projectSummary,
    });
  });
});
