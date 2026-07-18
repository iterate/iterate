import { describe, expect, it } from "vitest";
import type { PublicSessionResponse } from "@iterate-com/auth/client";
import { osPosthogContext } from "./posthog-context-model.ts";

function authenticatedSession(
  overrides: Partial<Extract<PublicSessionResponse, { authenticated: true }>["session"]> = {},
): Extract<PublicSessionResponse, { authenticated: true }> {
  return {
    authenticated: true,
    user: {
      id: "usr_123",
      email: "ada@example.com",
      emailVerified: true,
      isAdmin: false,
      name: "Ada Lovelace",
      role: "member",
    },
    session: {
      expiresAt: Date.UTC(2027, 0, 1),
      scope: "openid profile email",
      activeOrganizationId: "org_123",
      organizations: [
        {
          id: "org_123",
          name: "Analytical Engines",
          role: "owner",
          slug: "analytical-engines",
        },
      ],
      projects: [
        {
          id: "prj_123",
          organizationId: "org_123",
          slug: "difference-engine",
        },
      ],
      ...overrides,
    },
  };
}

describe("OS PostHog browser context", () => {
  it("uses the signed-in user as the person and organization/project as groups", () => {
    expect(
      osPosthogContext(authenticatedSession(), {
        id: "prj_123",
        organizationId: "org_123",
        slug: "difference-engine",
      }),
    ).toEqual({
      eventProperties: {
        organization_id: "org_123",
        project_id: "prj_123",
      },
      person: {
        distinctId: "usr_123",
        properties: {
          email: "ada@example.com",
          email_verified: true,
          is_admin: false,
          name: "Ada Lovelace",
          role: "member",
        },
      },
      groups: [
        {
          type: "organization",
          key: "org_123",
          properties: {
            id: "org_123",
            name: "Analytical Engines",
            slug: "analytical-engines",
          },
        },
        {
          type: "project",
          key: "prj_123",
          properties: {
            id: "prj_123",
            name: "difference-engine",
            organization_id: "org_123",
            slug: "difference-engine",
          },
        },
      ],
    });
  });

  it("does not manufacture a person for an anonymous browser", () => {
    expect(
      osPosthogContext(
        { authenticated: false },
        { id: "prj_123", organizationId: "org_123", slug: "difference-engine" },
      ),
    ).toBeNull();
  });

  it("keeps organization context on authenticated pages outside a project", () => {
    expect(osPosthogContext(authenticatedSession(), null)).toMatchObject({
      eventProperties: { organization_id: "org_123" },
      groups: [
        {
          type: "organization",
          key: "org_123",
          properties: {
            id: "org_123",
            name: "Analytical Engines",
            slug: "analytical-engines",
          },
        },
      ],
    });
  });

  it("does not expose a project operator's synthetic authorization organization", () => {
    expect(
      osPosthogContext(
        authenticatedSession({
          scope: "operator project",
          organizations: [
            {
              id: "operator:prj_123",
              name: "Project operator scope",
              role: "admin",
              slug: "operator-prj-123",
            },
          ],
        }),
        {
          id: "prj_123",
          organizationId: "operator:prj_123",
          slug: "difference-engine",
        },
      )?.groups,
    ).toEqual([
      {
        type: "project",
        key: "prj_123",
        properties: {
          id: "prj_123",
          name: "difference-engine",
          slug: "difference-engine",
        },
      },
    ]);
  });
});
