import { redirect } from "react-router";
import { asc, eq } from "drizzle-orm";
import { getDb } from "../../../backend/db/client.ts";
import { estate } from "../../../backend/db/schema.ts";
import { GlobalLoading } from "../../components/global-loading.tsx";
import type { Route } from "./+types/redirect.ts";

// Server-side loader that redirects to the first estate
export async function loader({ params }: Route.LoaderArgs) {
  const { organizationId } = params;
  if (!organizationId) throw redirect("/");
  // Get the first estate for this organization
  const firstEstate = await getDb().query.estate.findFirst({
    where: eq(estate.organizationId, organizationId),
    orderBy: asc(estate.createdAt),
  });
  if (!firstEstate) {
    throw new Error(`The organization ${organizationId} has no estates, this should never happen.`);
  }
  throw redirect(`/${organizationId}/${firstEstate.id}`);
}

export default function OrganizationRedirect() {
  // This should never render as the loader always redirects
  return <GlobalLoading />;
}
