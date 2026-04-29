import { OrganizationList } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";
import { requireSignedInForOrganizationRoute } from "~/lib/auth.ts";

export const Route = createFileRoute("/organization")({
  loader: () => requireSignedInForOrganizationRoute(),
  component: OrganizationRoute,
});

function OrganizationRoute() {
  return (
    <main className="grid min-h-svh place-items-center bg-background p-4">
      <OrganizationList
        hidePersonal
        afterCreateOrganizationUrl={organizationUrl}
        afterSelectOrganizationUrl={organizationUrl}
      />
    </main>
  );
}

function organizationUrl(organization: { slug?: string | null }) {
  return organization.slug ? `/orgs/${organization.slug}` : "/organization";
}
