import { createFileRoute, redirect } from "@tanstack/react-router";
import { Button } from "@iterate-com/ui/components/button";
import { fetchAuthSnapshot } from "~/lib/auth-snapshot.ts";

export const Route = createFileRoute("/not-an-admin")({
  beforeLoad: async () => {
    const auth = await fetchAuthSnapshot();
    if (!auth.authenticated) {
      throw redirect({ to: "/", replace: true });
    }
    if (auth.isAdmin) {
      throw redirect({ to: "/environments/", replace: true });
    }
    return { auth };
  },
  component: NotAnAdminPage,
});

function NotAnAdminPage() {
  const { auth } = Route.useRouteContext();

  return (
    <main className="grid min-h-svh place-items-center bg-background p-4 text-foreground">
      <div className="w-full max-w-sm space-y-6 rounded-xl border bg-card p-8 text-center shadow-sm">
        <div className="space-y-2">
          <h1 className="text-lg font-medium tracking-tight">Operator access required</h1>
          <p className="text-sm text-muted-foreground">
            You are signed in{auth.email ? ` as ${auth.email}` : ""}, but environment management
            requires an Iterate admin identity.
          </p>
        </div>
        <Button
          render={<a href="/api/iterate-auth/logout" aria-label="Sign out" />}
          variant="outline"
          className="w-full"
        >
          Sign out
        </Button>
      </div>
    </main>
  );
}
