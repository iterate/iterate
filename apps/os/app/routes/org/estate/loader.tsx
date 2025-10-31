import { Outlet, redirect, data } from "react-router";
import { getDb } from "../../../../backend/db/client.ts";
import { getAuth } from "../../../../backend/auth/auth.ts";
import { getUserEstateAccess } from "../../../../backend/trpc/trpc.ts";
import { isEstateOnboardingRequired } from "../../../../backend/onboarding-utils.ts";
import type { Route } from "./+types/loader.ts";

export async function loader({ request, params }: Route.LoaderArgs) {
  const { organizationId, estateId } = params;

  if (!organizationId || !estateId) {
    throw new Error("Organization ID and Estate ID are required");
  }

  const db = getDb();
  const auth = getAuth(db);

  // Get session
  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session?.user?.id) {
    throw redirect(`/login?redirectUrl=${encodeURIComponent(request.url)}`);
  }

  // Determine onboarding redirect and access in parallel to reduce latency
  const requestUrl = new URL(request.url);
  const isOnboardingPath = requestUrl.pathname.endsWith("/onboarding");
  const isIntegrationsRoute =
    requestUrl.pathname.includes("/integrations/redirect") ||
    requestUrl.pathname.includes("/integrations/callback");
  const [accessResult, needsOnboarding] = await Promise.all([
    getUserEstateAccess(db, session.user.id, estateId, organizationId),
    isOnboardingPath || isIntegrationsRoute
      ? Promise.resolve(false)
      : isEstateOnboardingRequired(db, estateId),
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
