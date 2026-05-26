import { Link, createFileRoute } from "@tanstack/react-router";
import { Building2 } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { useAuthClient } from "~/auth/client-context.ts";
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
      <div className="w-full max-w-sm space-y-4">
        {organizations.map((organization) => (
          <Button
            key={organization.id}
            variant="outline"
            className="h-11 w-full justify-start gap-2"
            render={
              <Link to="/org/$organizationSlug" params={{ organizationSlug: organization.slug }} />
            }
          >
            <Building2 className="size-4" />
            <span className="truncate">{organization.name}</span>
          </Button>
        ))}
        {!loading && organizations.length === 0 ? (
          <>
            <div className="space-y-1">
              <h1 className="text-lg font-semibold">Finish setup in Iterate Auth</h1>
              <p className="text-sm text-muted-foreground">
                Your account needs an organization before OS can open your workspace.
              </p>
            </div>
            <div className="flex gap-2">
              <Button onClick={signIn}>Continue with Iterate</Button>
            </div>
          </>
        ) : null}
      </div>
    </main>
  );
}
