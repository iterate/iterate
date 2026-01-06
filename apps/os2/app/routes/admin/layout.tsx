import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth.layout/admin")({
  component: AdminLayout,
});

function AdminLayout() {
  return (
    <div className="min-h-screen">
      <Outlet />
    </div>
  );
}
