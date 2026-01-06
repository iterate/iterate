import { createFileRoute, Link, Outlet, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth.layout/admin")({
  beforeLoad: async ({ context }) => {
    const user = await context.trpcClient.user.me.query();
    if (user?.role !== "admin") {
      throw redirect({ to: "/" });
    }
  },
  component: AdminLayout,
});

function AdminLayout() {
  return (
    <div className="flex min-h-screen">
      <aside className="w-64 border-r bg-muted/40 p-4">
        <h2 className="font-semibold text-lg mb-6">Admin</h2>
        <nav className="space-y-2">
          <Link
            to="/admin"
            className="block px-2 py-1.5 rounded-md hover:bg-accent"
            activeProps={{ className: "bg-accent" }}
            activeOptions={{ exact: true }}
          >
            Overview
          </Link>
          <Link
            to="/admin/session-info"
            className="block px-2 py-1.5 rounded-md hover:bg-accent"
            activeProps={{ className: "bg-accent" }}
          >
            Session Info
          </Link>
          <Link
            to="/admin/trpc-tools"
            className="block px-2 py-1.5 rounded-md hover:bg-accent"
            activeProps={{ className: "bg-accent" }}
          >
            tRPC Tools
          </Link>
        </nav>
      </aside>
      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}
