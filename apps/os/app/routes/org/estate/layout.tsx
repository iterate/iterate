import { z } from "zod";
import { notFound, Outlet, createFileRoute } from "@tanstack/react-router";
import { setResponseHeader } from "@tanstack/react-start/server";
import { getUserEstateAccess } from "../../../../backend/trpc/trpc.ts";
import { isValidTypeID } from "../../../../backend/utils/utils.ts";
import { authenticatedServerFn } from "../../../lib/auth-middleware.ts";

const assertEstateAccess = authenticatedServerFn
  .inputValidator(z.object({ organizationId: z.string(), estateId: z.string() }))
  .handler(async ({ context, data }) => {
    const { organizationId, estateId } = data;
    if (!isValidTypeID(organizationId, "org") || !isValidTypeID(estateId, "est")) throw notFound();

    const accessResult = await getUserEstateAccess(
      context.variables.db,
      context.variables.session.user.id,
      estateId,
      organizationId,
    );

    if (!accessResult.hasAccess || !accessResult.estate) {
      throw notFound({
        headers: {
          "Set-Cookie": "iterate-selected-estate=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
        },
      });
    }

    const estateData = JSON.stringify({ organizationId, estateId: accessResult.estate.id });
    const encodedData = encodeURIComponent(estateData);
    const expires = new Date();
    expires.setDate(expires.getDate() + 30);

    setResponseHeader(
      "Set-Cookie",
      `iterate-selected-estate=${encodedData}; Path=/; Expires=${expires.toUTCString()}; SameSite=Lax`,
    );

    return {
      estate: accessResult.estate,
    };
  });

export const Route = createFileRoute("/_auth.layout/$organizationId/$estateId")({
  component: Outlet,
  beforeLoad: ({ params }) =>
    assertEstateAccess({
      data: {
        organizationId: params.organizationId,
        estateId: params.estateId,
      },
    }),
});
