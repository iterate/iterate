import { Link, createFileRoute } from "@tanstack/react-router";
import { Building2 } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { useAuthClient } from "~/auth/client.tsx";
import { requireSignedInForOrganizationRoute } from "~/lib/auth.ts";

export const Route = createFileRoute("/organization")({
  loader: () => requireSignedInForOrganizationRoute(),
  component: OrganizationRoute,
});

function OrganizationRoute() {
  const { session, loading, signIn } = useAuthClient();
  const organizations = session?.authenticated ? session.session.organizations : [];

  return (
    <main className="grid min-h-svh place-items-center bg-background p-4">
      <div className="w-full max-w-sm space-y-3">
        {organizations.map((organization) => (
          <Button
            key={organization.id}
            variant="outline"
            className="h-11 w-full justify-start gap-2"
            render={
              <Link to="/orgs/$organizationSlug" params={{ organizationSlug: organization.slug }} />
            }
          >
            <Building2 className="size-4" />
            <span className="truncate">{organization.name}</span>
          </Button>
        ))}
        {!loading && organizations.length === 0 ? (
          <Button className="w-full" onClick={signIn}>
            Continue
          </Button>
        ) : null}
      </div>
    </main>
  );
}
