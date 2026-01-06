import * as React from "react";
import { createFileRoute, Outlet, Link, Navigate } from "@tanstack/react-router";
import { Shield, Terminal, Info } from "lucide-react";
import { useSessionUser } from "../../hooks/use-session-user.ts";
import { cn } from "../../lib/cn.ts";

export const Route = createFileRoute("/_auth-required.layout/_/admin")({
  component: AdminLayout,
});

function AdminLayout() {
  const { user, isLoading } = useSessionUser();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  // Only admins can access this layout
  if (user?.role !== "admin") {
    return <Navigate to="/" />;
  }

  return (
    <div className="flex h-screen">
      {/* Admin Sidebar */}
      <div className="w-64 border-r bg-muted/10">
        <div className="p-4 border-b">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            <span className="font-semibold">Admin</span>
          </div>
        </div>
        <nav className="p-4 space-y-1">
          <Link
            to="/admin"
            className={cn(
              "flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-accent",
            )}
          >
            <Shield className="h-4 w-4" />
            Dashboard
          </Link>
          <Link
            to="/admin/trpc-tools"
            className={cn(
              "flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-accent",
            )}
          >
            <Terminal className="h-4 w-4" />
            tRPC Tools
          </Link>
          <Link
            to="/admin/session-info"
            className={cn(
              "flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-accent",
            )}
          >
            <Info className="h-4 w-4" />
            Session Info
          </Link>
        </nav>
      </div>
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
