import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { estate } from "../../../backend/db/schema.ts";
import { isValidTypeID } from "../../../backend/utils/utils.ts";
import { authenticatedServerFn } from "../../lib/auth-middleware.ts";

const orgIndexRedirect = authenticatedServerFn
  .inputValidator(z.object({ organizationId: z.string() }))
  .handler(async ({ context, data }) => {
    const { organizationId } = data;
    const { db } = context.variables;

    if (!isValidTypeID(organizationId, "org")) {
      throw notFound();
    }

    const firstEstate = await db.query.estate.findFirst({
      where: eq(estate.organizationId, organizationId),
      orderBy: asc(estate.createdAt),
    });
    if (!firstEstate) {
      throw new Error(
        `The organization ${organizationId} has no estates, this should never happen.`,
      );
    }
    throw redirect({
      to: `/$organizationId/$estateId`,
      params: { organizationId, estateId: firstEstate.id },
    });
  });

export const Route = createFileRoute("/_auth.layout/$organizationId/")({
  loader: ({ params }) => orgIndexRedirect({ data: params }),
});
