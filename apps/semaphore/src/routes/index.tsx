import { createFileRoute, redirect } from "@tanstack/react-router";
import iterateLogoAsset from "@iterate-com/ui/assets/iterate-logo.svg";
import { fetchAuthSnapshot } from "~/lib/auth-snapshot.ts";

export const Route = createFileRoute("/")({
  // Signed-in visitors go straight to the dashboard; everyone else lands on
  // the sign-in page below. Deep links under /_app keep their own gate, which
  // redirects into the OIDC flow with the original URL as return_to.
  beforeLoad: async () => {
    const auth = await fetchAuthSnapshot();
    if (auth.authenticated) {
      throw redirect({ to: "/resources/", replace: true });
    }
  },
  component: LandingPage,
});

function LandingPage() {
  return (
    <main className="grid min-h-svh place-items-center bg-background p-4 text-foreground">
      <div className="w-full max-w-sm space-y-6 rounded-lg border bg-card p-8 text-center">
        <img src={iterateLogoAsset} alt="" className="mx-auto h-10 w-10" />
        <div className="space-y-1">
          <h1 className="text-lg font-medium tracking-tight">semaphore</h1>
          <p className="text-sm text-muted-foreground">
            Resource leases and preview environments for the iterate fleet.
          </p>
        </div>
        <a
          href={`/api/iterate-auth/login?${new URLSearchParams({ return_to: "/resources/" })}`}
          className="block w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Sign in with iterate
        </a>
        <p className="text-xs text-muted-foreground">
          Operator access requires an iterate admin identity.
        </p>
      </div>
    </main>
  );
}
