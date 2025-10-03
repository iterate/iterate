import { redirect } from "react-router";
import type { Route } from "./+types/org-billing";

export async function loader({ params }: Route.LoaderArgs) {
  const { organizationId } = params;
  if (!organizationId) {
    throw redirect("/");
  }
  // For now, redirect to a placeholder Stripe billing portal URL pattern.
  // In a real implementation, we'd call a backend endpoint to create a session and redirect.
  const billingUrl = `/api/billing/organizations/${organizationId}`;
  throw redirect(billingUrl);
}

export default function OrgBilling() {
  return null;
}

