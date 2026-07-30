import { createFileRoute, redirect } from "@tanstack/react-router";
import iterateLogoAsset from "@iterate-com/ui/assets/iterate-logo.svg";
import { Button } from "@iterate-com/ui/components/button";
import { fetchAuthSnapshot } from "~/lib/auth-snapshot.ts";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const auth = await fetchAuthSnapshot();
    if (auth.authenticated) {
      throw redirect({ to: "/environments/", replace: true });
    }
  },
  component: LandingPage,
});

function LandingPage() {
  const loginUrl = `/api/iterate-auth/login?${new URLSearchParams({
    return_to: "/environments/",
  })}`;

  return (
    <main className="grid min-h-svh place-items-center bg-background p-4 text-foreground">
      <div className="w-full max-w-sm space-y-6 rounded-xl border bg-card p-8 text-center shadow-sm">
        <img src={iterateLogoAsset} alt="" className="mx-auto size-10" />
        <div className="space-y-2">
          <h1 className="text-lg font-medium tracking-tight">Environment manager</h1>
          <p className="text-sm text-muted-foreground">
            Create, inspect, and completely destroy Iterate preview environments.
          </p>
        </div>
        <Button
          render={<a href={loginUrl} aria-label="Sign in with Iterate" />}
          size="lg"
          className="w-full"
        >
          Sign in with Iterate
        </Button>
        <p className="text-xs text-muted-foreground">
          This control plane requires an Iterate admin identity.
        </p>
      </div>
    </main>
  );
}
