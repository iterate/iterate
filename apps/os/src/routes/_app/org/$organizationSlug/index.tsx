import { createFileRoute } from "@tanstack/react-router";
import { requireActiveOrganizationForOrgRoute } from "~/lib/auth.ts";

export const Route = createFileRoute("/_app/org/$organizationSlug/")({
  beforeLoad: ({ params }) =>
    requireActiveOrganizationForOrgRoute({
      data: { organizationSlug: params.organizationSlug },
    }),
  loader: ({ params }) => ({
    breadcrumb: params.organizationSlug,
  }),
  component: OrganizationPage,
});

function OrganizationPage() {
  const params = Route.useParams();

  return (
    <section className="max-w-2xl space-y-2 p-4">
      <h2 className="text-sm font-semibold">{params.organizationSlug}</h2>
      <p className="text-sm text-muted-foreground">Organization settings are not available yet.</p>
    </section>
  );
}
