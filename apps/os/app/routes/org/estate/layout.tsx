import { z } from "zod";
import { notFound, Outlet, redirect, createFileRoute } from "@tanstack/react-router";
import { setResponseHeader } from "@tanstack/react-start/server";
import { getUserEstateAccess } from "../../../../backend/trpc/trpc.ts";
import { isEstateOnboardingRequired } from "../../../../backend/onboarding-utils.ts";
import { isValidTypeID } from "../../../../backend/utils/utils.ts";
import { authenticatedServerFn } from "../../../lib/auth-middleware.ts";

const assertDoesNotNeedOnboarding = authenticatedServerFn
  .inputValidator(
    z.object({ organizationId: z.string(), estateId: z.string(), pathname: z.string() }),
  )
  .handler(async ({ context, data }) => {
    const { organizationId, estateId, pathname } = data;
    if (!isValidTypeID(organizationId, "org") || !isValidTypeID(estateId, "est")) throw notFound();

    const isOnboardingPath = pathname.endsWith("/onboarding");

    const [accessResult, needsOnboarding] = await Promise.all([
      getUserEstateAccess(
        context.variables.db,
        context.variables.session.user.id,
        estateId,
        organizationId,
      ),
      isOnboardingPath
        ? Promise.resolve(false)
        : isEstateOnboardingRequired(context.variables.db, estateId),
    ]);

    if (!accessResult.hasAccess || !accessResult.estate) {
      throw notFound({
        headers: {
          "Set-Cookie": "iterate-selected-estate=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
        },
      });
    }

    if (needsOnboarding && !isOnboardingPath) {
      throw redirect({
        to: `/$organizationId/$estateId/onboarding`,
        params: { organizationId, estateId },
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
  beforeLoad: ({ params, location }) =>
    assertDoesNotNeedOnboarding({
      data: {
        organizationId: params.organizationId,
        estateId: params.estateId,
        pathname: location.pathname,
      },
    }),
});
