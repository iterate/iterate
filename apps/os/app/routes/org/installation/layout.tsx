import { z } from "zod";
import { notFound, Outlet, redirect, createFileRoute } from "@tanstack/react-router";
import { setResponseHeader } from "@tanstack/react-start/server";
import { getUserInstallationAccess } from "../../../../backend/trpc/trpc.ts";
import { isInstallationOnboardingRequired } from "../../../../backend/onboarding-utils.ts";
import { isValidTypeID } from "../../../../backend/utils/utils.ts";
import { authenticatedServerFn } from "../../../lib/auth-middleware.ts";

function shouldBypassOnboardingCheck(pathname: string): boolean {
  if (pathname.endsWith("/onboarding")) return true;
  if (pathname.includes("/integrations/redirect")) return true;
  if (pathname.includes("/integrations/mcp-params")) return true;
  return false;
}

const assertDoesNotNeedOnboarding = authenticatedServerFn
  .inputValidator(
    z.object({ organizationId: z.string(), installationId: z.string(), pathname: z.string() }),
  )
  .handler(async ({ context, data }) => {
    const { organizationId, installationId, pathname } = data;
    if (!isValidTypeID(organizationId, "org") || !isValidTypeID(installationId, "ins"))
      throw notFound();

    const bypassOnboardingCheck = shouldBypassOnboardingCheck(pathname);

    const [accessResult, needsOnboarding] = await Promise.all([
      getUserInstallationAccess(
        context.variables.db,
        context.variables.session.user.id,
        installationId,
        organizationId,
      ),
      bypassOnboardingCheck
        ? Promise.resolve(false)
        : isInstallationOnboardingRequired(context.variables.db, installationId),
    ]);

    if (!accessResult.hasAccess || !accessResult.installation) {
      throw notFound({
        headers: {
          "Set-Cookie":
            "iterate-selected-installation=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
        },
      });
    }

    if (needsOnboarding && !bypassOnboardingCheck) {
      throw redirect({
        to: `/$organizationId/$installationId/onboarding`,
        params: { organizationId, installationId },
      });
    }

    const installationData = JSON.stringify({
      organizationId,
      installationId: accessResult.installation.id,
    });
    const encodedData = encodeURIComponent(installationData);
    const expires = new Date();
    expires.setDate(expires.getDate() + 30);

    setResponseHeader(
      "Set-Cookie",
      `iterate-selected-installation=${encodedData}; Path=/; Expires=${expires.toUTCString()}; SameSite=Lax`,
    );

    return {
      installation: accessResult.installation,
    };
  });

export const Route = createFileRoute("/_auth.layout/$organizationId/$installationId")({
  component: Outlet,
  beforeLoad: ({ params, location }) =>
    assertDoesNotNeedOnboarding({
      data: {
        organizationId: params.organizationId,
        installationId: params.installationId,
        pathname: location.pathname,
      },
    }),
});
