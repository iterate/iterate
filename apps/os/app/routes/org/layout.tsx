import { notFound, Outlet, redirect } from "@tanstack/react-router";
import { eq } from "drizzle-orm";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { schema } from "../../../backend/db/client.ts";
import { getUserOrganizations } from "../../../backend/trpc/trpc.ts";
import { DashboardLayout } from "../../components/dashboard-layout.tsx";
import { isValidTypeID } from "../../../backend/utils/utils.ts";
import { authenticatedServerFn } from "../../lib/auth-middleware.ts";

const orgLoader = authenticatedServerFn
  .inputValidator(z.object({ organizationId: z.string() }))
  .handler(async ({ context, data }) => {
    const { organizationId } = data;
    const { session, db } = context.variables;

    if (!isValidTypeID(organizationId, "org")) {
      throw notFound();
    }

    const estates = await db.query.estate.findMany({
      where: eq(schema.estate.organizationId, organizationId),
      orderBy: (t, { asc }) => [asc(t.createdAt)],
      with: {
        organization: {
          columns: { name: true },
        },
      },
    });

    if (!estates.length) {
      // No estate for this org; redirect to home
      throw redirect({ to: "/" });
    }

    const userOrganizations = await getUserOrganizations(db, session.user.id);

    // Check if user has access to the requested organization
    // Note: External users are already filtered out at query level
    const currentOrgMembership = userOrganizations.find(
      (m) => m.organization.id === organizationId,
    );

    if (!currentOrgMembership) {
      throw new Response("Not found", { status: 404 });
    }

    const organization = currentOrgMembership.organization;

    // Serialize dates to match TRPC output format
    // External orgs already filtered at query level
    const organizations = userOrganizations.map(({ organization: org, role }) => ({
      ...org,
      createdAt: org.createdAt.toISOString(),
      updatedAt: org.updatedAt.toISOString(),
      role,
    }));

    const serializedOrganization = {
      ...organization,
      createdAt: organization.createdAt.toISOString(),
      updatedAt: organization.updatedAt.toISOString(),
    };

    const serializedEstates = estates.map(({ organization, ...rest }) => ({
      ...rest,
      createdAt: rest.createdAt.toISOString(),
      updatedAt: rest.updatedAt.toISOString(),
      organizationName: organization.name,
    }));

    return {
      organization: serializedOrganization,
      organizations,
      estates: serializedEstates,
    };
  });

export const Route = createFileRoute("/_auth.layout/$organizationId")({
  component: OrganizationLayout,
  loader: ({ params }) => orgLoader({ data: params }),
});

function OrganizationLayout() {
  return (
    <DashboardLayout>
      <Outlet />
    </DashboardLayout>
  );
}
