import { redirect } from "react-router";
import type { Route } from "./+types/organization-billing-redirect";

// For now, simply redirect to an external billing portal URL if configured.
export async function loader({ request, params }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const base = `${url.protocol}//${url.host}`;
  const { organizationId } = params;

  if (!organizationId) {
    return redirect("/");
  }

  // Placeholder: In future, fetch Stripe customer portal URL for org
  // For now, just send to a generic billing page (replace when backend is ready)
  const portalUrl = `${base}/billing?org=${encodeURIComponent(organizationId)}`;
  return redirect(portalUrl);
}

export default function OrganizationBillingRedirect() {
  return null;
}

