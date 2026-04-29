import { createFileRoute, redirect } from "@tanstack/react-router";
import { requireActiveOrganizationForRoute } from "../lib/auth.ts";

export const Route = createFileRoute("/")({
  loader: async () => {
    const auth = await requireActiveOrganizationForRoute();
    throw redirect({
      to: "/orgs/$organizationSlug",
      params: { organizationSlug: auth.orgSlug },
      replace: true,
    });
  },
});
