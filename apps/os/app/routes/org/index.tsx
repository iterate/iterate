import { redirect } from "react-router";
import { asc, eq } from "drizzle-orm";
import { estate } from "../../../backend/db/schema.ts";
import { ReactRouterServerContext } from "../../context.ts";
import type { Route } from "./+types/index.ts";

// Server-side loader that redirects to the first estate
export async function loader({ params, context }: Route.LoaderArgs) {
  const { db } = context.get(ReactRouterServerContext).variables;
  const { organizationId } = params;
  if (!organizationId) throw redirect("/");
  // Get the first estate for this organization
  const firstEstate = await db.query.estate.findFirst({
    where: eq(estate.organizationId, organizationId),
    orderBy: asc(estate.createdAt),
  });
  if (!firstEstate) {
    throw new Error(`The organization ${organizationId} has no estates, this should never happen.`);
  }
  throw redirect(`/${organizationId}/${firstEstate.id}`);
}
