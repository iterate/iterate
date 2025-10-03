import { redirect } from "react-router";
import { and, eq } from "drizzle-orm";
import { GlobalLoading } from "../components/global-loading.tsx";
import { getDb } from "../../backend/db/client.ts";
import { getAuth } from "../../backend/auth/auth.ts";
import { organization, organizationUserMembership } from "../../backend/db/schema.ts";
import type { Route } from "./+types/org-redirect";

export async function loader({ request, params }: Route.LoaderArgs) {
  const db = getDb();
  const auth = getAuth(db);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.id) {
    throw redirect("/login");
  }

  const organizationId = params.organizationId;
  if (!organizationId) {
    throw redirect("/");
  }

  // Ensure the user belongs to this organization
  const membership = await db.query.organizationUserMembership.findFirst({
    where: and(
      eq(organizationUserMembership.userId, session.user.id),
      eq(organizationUserMembership.organizationId, organizationId),
    ),
  });

  if (!membership) {
    throw redirect("/");
  }

  // Get estates in this organization and redirect to the first one
  const orgWithEstates = await db.query.organization.findFirst({
    where: eq(organization.id, organizationId),
    with: { estates: true },
  });

  const firstEstateId = orgWithEstates?.estates?.[0]?.id;
  if (firstEstateId) {
    throw redirect(`/${organizationId}/${firstEstateId}/`);
  }

  // If no estates, go to org settings
  throw redirect(`/${organizationId}/settings`);
}

export default function OrgRedirect() {
  return <GlobalLoading />;
}

