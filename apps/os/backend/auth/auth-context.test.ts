import { beforeEach, describe, expect, it, vi } from "vitest";
import { ORPCError } from "@orpc/server";
import { getProjectAccessFromAuthWorker, isAuthWorkerAccessDeniedError } from "./auth-context.ts";

vi.mock("../utils/auth-worker-client.ts", () => ({
  createAuthWorkerClient: vi.fn(),
}));

describe("auth-context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("syncs local project name and auth organization slug when auth metadata changes", async () => {
    const { createAuthWorkerClient } = await import("../utils/auth-worker-client.ts");

    const updateReturning = {
      id: "proj_local",
      authProjectId: "auth_proj_123",
      authOrganizationId: "org_auth_123",
      authOrganizationSlug: "renamed-org",
      name: "Renamed Project",
      slug: "demo",
      updatedAt: new Date("2026-04-22T00:00:00.000Z"),
    };
    const db = {
      query: {
        project: {
          findFirst: vi
            .fn()
            .mockResolvedValueOnce({
              id: "proj_local",
              authProjectId: "auth_proj_123",
              authOrganizationId: "org_auth_123",
              authOrganizationSlug: "old-org",
              name: "Old Project",
              slug: "demo",
              envVars: [],
              accessTokens: [],
              connections: [],
            })
            .mockResolvedValueOnce(undefined),
        },
      },
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([updateReturning]),
          })),
        })),
      })),
    };

    vi.mocked(createAuthWorkerClient).mockReturnValue({
      project: {
        bySlug: vi.fn().mockResolvedValue({
          id: "auth_proj_123",
          organizationId: "org_auth_123",
          name: "Renamed Project",
          slug: "demo",
        }),
      },
      user: {
        myOrganizations: vi.fn().mockResolvedValue([
          {
            id: "org_auth_123",
            slug: "renamed-org",
            name: "Renamed Org",
            role: "owner",
          },
        ]),
      },
    } as never);

    const access = await getProjectAccessFromAuthWorker({
      db: db as never,
      authUserId: "auth_usr_123",
      projectSlug: "demo",
    });

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(access.project.name).toBe("Renamed Project");
    expect(access.project.authOrganizationSlug).toBe("renamed-org");
  });

  it("recognizes access-denied auth worker errors", () => {
    expect(isAuthWorkerAccessDeniedError(new ORPCError("FORBIDDEN"))).toBe(true);
    expect(isAuthWorkerAccessDeniedError(new ORPCError("NOT_FOUND"))).toBe(true);
    expect(isAuthWorkerAccessDeniedError(new ORPCError("UNAUTHORIZED"))).toBe(true);
    expect(isAuthWorkerAccessDeniedError(new ORPCError("INTERNAL_SERVER_ERROR"))).toBe(false);
  });
});
