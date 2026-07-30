import {
  Link,
  Outlet,
  createFileRoute,
  redirect,
  type RegisteredRouter,
} from "@tanstack/react-router";
import iterateLogoAsset from "@iterate-com/ui/assets/iterate-logo.svg";
import { Button } from "@iterate-com/ui/components/button";
import { fetchAuthSnapshot } from "~/lib/auth-snapshot.ts";

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ location }) => {
    const auth = await fetchAuthSnapshot();
    if (!auth.authenticated) {
      throw redirect<RegisteredRouter, "./">({
        href: `/api/iterate-auth/login?${new URLSearchParams({ return_to: location.href })}`,
      });
    }
    if (!auth.isAdmin) {
      throw redirect({ to: "/not-an-admin/" });
    }
    return { auth };
  },
  component: AppLayout,
});

function AppLayout() {
  const { auth } = Route.useRouteContext();

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
          <Link to="/environments/" className="flex items-center gap-2 font-medium tracking-tight">
            <img src={iterateLogoAsset} alt="" className="size-6" />
            Environment manager
          </Link>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-muted-foreground sm:inline">{auth.email}</span>
            <Button
              render={<a href="/api/iterate-auth/logout" aria-label="Sign out" />}
              variant="ghost"
              size="sm"
            >
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl p-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
