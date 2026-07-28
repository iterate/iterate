import { describe, expect, it } from "vitest";
import { canReadDirectoryProject } from "./project-directory-authorization.ts";
import { adminPrincipal, createUserPrincipal } from "~/auth/principal.ts";

const organization = {
  id: "org_customer",
  name: "Customer Organization",
  role: "member" as const,
  slug: "customer-organization",
};

const userPrincipal = createUserPrincipal({
  organizations: [organization],
  projects: [],
  userId: "usr_customer",
});

describe("project directory authorization", () => {
  it("does not widen a project-scoped operator through organization membership", () => {
    expect(
      canReadDirectoryProject({
        isProjectScopedOperator: true,
        principal: userPrincipal,
        recordOrganizationId: organization.id,
      }),
    ).toBe(false);
  });

  it("preserves directory fallback for ordinary organization members and admins", () => {
    expect(
      canReadDirectoryProject({
        isProjectScopedOperator: false,
        principal: userPrincipal,
        recordOrganizationId: organization.id,
      }),
    ).toBe(true);
    expect(
      canReadDirectoryProject({
        isProjectScopedOperator: false,
        principal: adminPrincipal,
        recordOrganizationId: "org_other",
      }),
    ).toBe(true);
    expect(
      canReadDirectoryProject({
        isProjectScopedOperator: false,
        principal: userPrincipal,
        recordOrganizationId: "org_other",
      }),
    ).toBe(false);
  });
});
