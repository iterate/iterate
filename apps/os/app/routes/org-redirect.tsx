import { redirect } from "react-router";
import { eq } from "drizzle-orm";
import { getDb } from "../../backend/db/client.ts";
import { estate } from "../../backend/db/schema.ts";

export async function loader({ params }: { params: { organizationId: string } }) {
  const { organizationId } = params;

  // Get first estate for this org
  const firstEstate = await getDb().query.estate.findFirst({
    where: eq(estate.organizationId, organizationId),
  });

  if (!firstEstate) {
    throw redirect("/no-access");
  }

  throw redirect(`/${organizationId}/${firstEstate.id}`);
}

export default function OrgRedirect() {
  return null; // Never renders
}
