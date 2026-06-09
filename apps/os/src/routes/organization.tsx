import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@iterate-com/ui/components/button";
import { requireSignedInForOrganizationSession, type OrganizationRouteAuth } from "~/lib/auth.ts";

export const Route = createFileRoute("/organization")({
  loader: ({ context, location }): OrganizationRouteAuth =>
    requireSignedInForOrganizationSession(context.authSession, location, context.iterateAuthIssuer),
  component: OrganizationRoute,
});

function OrganizationRoute() {
  const { authProjectAccessUrl } = Route.useLoaderData();

  return (
    <main className="grid min-h-svh place-items-center bg-background p-4">
      <div className="w-full max-w-sm space-y-4">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">Finish setup in Iterate Auth</h1>
          <p className="text-sm text-muted-foreground">
            Your account needs an organization before OS can open your workspace.
          </p>
        </div>
        {authProjectAccessUrl ? (
          <Button className="w-full" render={<a href={authProjectAccessUrl}>Continue setup</a>} />
        ) : (
          <p className="text-sm text-muted-foreground">Auth onboarding is not configured.</p>
        )}
      </div>
    </main>
  );
}
