import { createFileRoute, redirect } from "@tanstack/react-router";
import { fetchAuthSnapshot } from "~/lib/auth-snapshot.ts";

export const Route = createFileRoute("/not-an-admin")({
  // Landing spot for signed-in non-admins (the /_app gate redirects here).
  // Anyone who doesn't belong here gets bounced to the right place instead.
  beforeLoad: async () => {
    const auth = await fetchAuthSnapshot();
    if (!auth.authenticated) {
      throw redirect({ to: "/", replace: true });
    }
    if (auth.isAdmin) {
      throw redirect({ to: "/resources/", replace: true });
    }
    return { auth };
  },
  component: NotAnAdminPage,
});

function NotAnAdminPage() {
  const { auth } = Route.useRouteContext();

  return (
    <main className="grid min-h-svh place-items-center bg-background p-4 text-foreground">
      <div className="w-full max-w-sm space-y-6 rounded-lg border bg-card p-8 text-center">
        <div className="space-y-2">
          <h1 className="text-lg font-medium tracking-tight">Operator access required</h1>
          <p className="text-sm text-muted-foreground">
            You are signed in{auth.email ? ` as ${auth.email}` : ""}, but semaphore is operator
            tooling and requires an iterate admin identity.
          </p>
        </div>
        <a
          href="/api/iterate-auth/logout"
          className="block w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Sign out
        </a>
        <p className="text-xs text-muted-foreground">
          Sign back in with an admin account, or ask an admin to grant your account the role.
        </p>
      </div>
    </main>
  );
}
