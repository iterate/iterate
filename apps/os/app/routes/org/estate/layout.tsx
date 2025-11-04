import { Outlet, redirect, data } from "react-router";
import { getUserEstateAccess } from "../../../../backend/trpc/trpc.ts";
import { isEstateOnboardingRequired } from "../../../../backend/onboarding-utils.ts";
import { ReactRouterServerContext } from "../../../context.ts";
import type { Route } from "./+types/layout.ts";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { organizationId, estateId } = params;
  const { db, session } = context.get(ReactRouterServerContext).variables;

  // Get session
  if (!session?.user?.id) {
    throw redirect(`/login?redirectUrl=${encodeURIComponent(request.url)}`);
  }

  // Determine onboarding redirect and access in parallel to reduce latency
  const isOnboardingPath = new URL(request.url).pathname.endsWith("/onboarding");
  const [accessResult, needsOnboarding] = await Promise.all([
    getUserEstateAccess(db, session.user.id, estateId, organizationId),
    isOnboardingPath ? Promise.resolve(false) : isEstateOnboardingRequired(db, estateId),
  ]);

  const { hasAccess: hasEstateAccess, estate: userEstate } = accessResult;

  if (!hasEstateAccess || !userEstate) {
    const headers = new Headers();
    headers.append(
      "Set-Cookie",
      "iterate-selected-estate=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    );

    throw new Response("You don't have access to this estate", {
      status: 403,
      statusText: "Forbidden",
      headers,
    });
  }

  if (needsOnboarding) {
    throw redirect(`/${organizationId}/${estateId}/onboarding`);
  }

  // Set estate cookie
  const estateData = JSON.stringify({ organizationId, estateId: userEstate.id });
  const encodedData = encodeURIComponent(estateData);
  const expires = new Date();
  expires.setDate(expires.getDate() + 30);

  const responseHeaders = new Headers({ "Content-Type": "application/json" });
  responseHeaders.append(
    "Set-Cookie",
    `iterate-selected-estate=${encodedData}; Path=/; Expires=${expires.toUTCString()}; SameSite=Lax`,
  );

  return data(
    {
      estate: userEstate,
    },
    {
      headers: responseHeaders,
    },
  );
}

export default function EstateLayout() {
  return <Outlet />;
}
