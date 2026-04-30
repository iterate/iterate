import { createFileRoute, redirect } from "@tanstack/react-router";
import { requireAuthenticatedRootRedirectTarget } from "../lib/auth.ts";

export const Route = createFileRoute("/")({
  loader: async () => {
    const target = await requireAuthenticatedRootRedirectTarget();
    if (target.projectSlug) {
      throw redirect({
        to: "/orgs/$organizationSlug/projects/$projectSlug/run-code",
        params: { organizationSlug: target.orgSlug, projectSlug: target.projectSlug },
        replace: true,
      });
    }

    throw redirect({
      to: "/orgs/$organizationSlug",
      params: { organizationSlug: target.orgSlug },
      replace: true,
    });
  },
});
