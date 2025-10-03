import { redirect } from "react-router";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../../backend/db/client.ts";
import { getAuth } from "../../backend/auth/auth.ts";
import { organizationUserMembership } from "../../backend/db/schema.ts";
import type { Route } from "./+types/organization-redirect";

export async function loader({ request, params }: Route.LoaderArgs) {
  const { organizationId } = params;
  const db = getDb();
  const auth = getAuth(db);
  const session = await auth.api.getSession({ headers: request.headers });

  if (!session?.user?.id || !organizationId) {
    throw redirect("/");
  }

  const membership = await db.query.organizationUserMembership.findFirst({
    where: eq(organizationUserMembership.organizationId, organizationId),
  });

  if (!membership) {
    throw redirect("/no-access");
  }

  // Find first estate in this organization and redirect to it
  const org = await db.query.organization.findFirst({
    where: eq(schema.organization.id, organizationId),
    with: { estates: true },
  });

  const firstEstate = org?.estates?.[0];
  if (firstEstate) {
    throw redirect(`/${organizationId}/${firstEstate.id}`);
  }

  // If no estates yet, stay on org settings
  throw redirect(`/${organizationId}/settings`);
}

export default function OrganizationRedirect() {
  return null;
}

