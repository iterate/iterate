import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { installation } from "../../../backend/db/schema.ts";
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

    const firstInstallation = await db.query.installation.findFirst({
      where: eq(installation.organizationId, organizationId),
      orderBy: asc(installation.createdAt),
    });
    if (!firstInstallation) {
      throw new Error(
        `The organization ${organizationId} has no installations, this should never happen.`,
      );
    }
    throw redirect({
      to: `/$organizationId/$installationId`,
      params: { organizationId, installationId: firstInstallation.id },
    });
  });

export const Route = createFileRoute("/_auth.layout/$organizationId/")({
  loader: ({ params }) => orgIndexRedirect({ data: params }),
});
