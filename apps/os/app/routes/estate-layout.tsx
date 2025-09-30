import { Outlet, redirect } from "react-router";
import { getDb } from "../../backend/db/client.ts";
import { getAuth } from "../../backend/auth/auth.ts";
import { getUserEstateAccess } from "../../backend/trpc/trpc.ts";
import { DashboardLayout } from "../components/dashboard-layout.tsx";
import type { Route } from "./+types/estate-layout";

// Server-side loader that checks estate access
export async function loader({ request, params }: Route.LoaderArgs) {
  const { organizationId, estateId } = params;

  // Get the database and auth instances
  const db = getDb();
  const auth = getAuth(db);

  // Get session using Better Auth
  const session = await auth.api.getSession({
    headers: request.headers,
  });

  // If no session, redirect to login
  if (!session?.user?.id) {
    throw redirect(`/login?redirectUrl=${encodeURIComponent(request.url)}`);
  }

  // Validate params exist
  if (!organizationId || !estateId) {
    throw redirect("/");
  }

  // Check if user has access to this estate
  const { hasAccess } = await getUserEstateAccess(db, session.user.id, estateId, organizationId);

  if (!hasAccess) {
    // Clear the invalid estate cookie by setting an expired cookie
    const headers = new Headers();
    headers.append(
      "Set-Cookie",
      "iterate-selected-estate=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    );

    // Redirect to root to find a valid estate
    throw redirect("/", { headers });
  }

  // User has access, set the estate cookie for future use
  const estateData = JSON.stringify({ organizationId, estateId });
  const encodedData = encodeURIComponent(estateData);
  const expires = new Date();
  expires.setDate(expires.getDate() + 30);

  return new Response(null, {
    headers: {
      "Set-Cookie": `iterate-selected-estate=${encodedData}; Path=/; Expires=${expires.toUTCString()}; SameSite=Lax`,
    },
  });
}

// The component just renders the outlet since access is already checked
export default function EstateLayout() {
  return (
    <DashboardLayout>
      <Outlet />
    </DashboardLayout>
  );
}
