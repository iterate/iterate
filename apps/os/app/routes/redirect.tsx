import { redirect } from "react-router";
import { GlobalLoading } from "../components/global-loading.tsx";
import { getDb } from "../../backend/db/client.ts";
import { getAuth } from "../../backend/auth/auth.ts";
import { determineUserRedirect } from "../../backend/redirect-logic.ts";
import { appendEstatePath } from "./append-estate-path.ts";
import type { Route } from "./+types/redirect.ts";

/**
 * Root redirect route - centralized logic for routing users.
 *
 * This is the single source of truth for:
 * - Creating org/estate if user doesn't have one
 * - Checking for pending onboarding steps
 * - Kicking off background onboarding processing
 * - Routing to the appropriate page
 */
export async function loader({ request }: Route.LoaderArgs) {
  const db = getDb();
  const auth = getAuth(db);

  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session?.user?.id) {
    throw redirect("/login");
  }

  const { redirect: targetUrl } = await determineUserRedirect(db, session.user);

  // Note: Background onboarding processing already happens in org-utils.ts
  // via waitUntil when the org/estate is created. We don't need to trigger it again here.
  // The cron will also retry any failed onboardings automatically.

  // Handle estate_path query parameter
  let finalPath = targetUrl;
  const estatePath = new URL(request.url).searchParams.get("estate_path");
  if (estatePath && finalPath.match(/\/org_\w+\/est_\w+$/)) {
    finalPath = appendEstatePath(finalPath, estatePath);
  }

  throw redirect(finalPath);
}

// The component is minimal since all logic is in the loader
export default function RootRedirect() {
  // This should never render as the loader always redirects
  return <GlobalLoading />;
}
