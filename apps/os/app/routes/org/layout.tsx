import { Outlet, redirect, data } from "react-router";
import { eq } from "drizzle-orm";
import { schema } from "../../../backend/db/client.ts";
import { getUserOrganizations } from "../../../backend/trpc/trpc.ts";
import { DashboardLayout } from "../../components/dashboard-layout.tsx";
import { ReactRouterServerContext } from "../../context.ts";
import { isValidTypeID } from "../../../backend/utils/utils.ts";
import type { Route } from "./+types/layout.ts";

// Server-side loader that checks organization access
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { organizationId } = params;
  const { session, db } = context.get(ReactRouterServerContext).variables;

  if (!isValidTypeID(organizationId, "org")) {
    throw new Response("Not found", { status: 404 });
  }

  if (!session?.user?.id) {
    throw redirect(`/login?redirectUrl=${encodeURIComponent(request.url)}`);
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
    throw redirect("/");
  }

  const userOrganizations = await getUserOrganizations(db, session.user.id);

  // Check if user has access to the requested organization
  // Note: External users are already filtered out at query level
  const currentOrgMembership = userOrganizations.find((m) => m.organization.id === organizationId);

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

  return data({
    organization: serializedOrganization,
    organizations,
    estates: serializedEstates,
  });
}

export default function OrganizationLayout() {
  return (
    <DashboardLayout>
      <Outlet />
    </DashboardLayout>
  );
}
